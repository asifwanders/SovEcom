/**
 * the production {@link WorkerChannel}: a real `child_process.fork`
 *. This is where the OS-process isolation actually happens:
 *
 *   - **Scrubbed env:** the child receives ONLY the explicit `env` we pass — `process.env` is
 *     NOT inherited, so `DATABASE_URL`, `REDIS_URL`, app secrets, and the master key never
 *     reach module code.
 *   - **Node Permission Model:** forked with `--permission` + `--allow-fs-read`/`--allow-fs-write`
 *     scoped to the module's own dirs, and WITHOUT `--allow-child-process`/`--allow-worker`/
 *     `--allow-addons` — so a module cannot read other modules / secrets, spawn subprocesses,
 *     or load native addons. Network is denied at the deployment boundary.
 *   - **Heap cap** via `--max-old-space-size`, and stdout/stderr piped (never wired to core's).
 *   - **Crash isolation:** child exit/error closes the channel; it never propagates into core.
 */
import { fork, type ChildProcess } from 'child_process';

import type { WorkerChannel } from './worker-channel';

export interface ForkOptions {
  /** Absolute path to the worker entry module to fork. */
  readonly entry: string;
  /** Argv passed to the entry (after node flags). */
  readonly args?: readonly string[];
  /** Directories the worker may READ (its code dir, node_modules, its own data dir). */
  readonly allowFsRead: readonly string[];
  /** Directories the worker may WRITE (its own data dir only). */
  readonly allowFsWrite: readonly string[];
  /** V8 heap cap (MiB). Default 256. */
  readonly maxOldSpaceMb?: number;
  /**
   * The EXACT env handed to the child. Defaults to `{}` (nothing inherited). The caller passes
   * only non-secret identity vars (e.g. module name, tenant id) — NEVER credentials.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Grace period (ms) after SIGTERM before SIGKILL on close. Default 2000. */
  readonly killGraceMs?: number;
}

/** Build the node flags that engage the sandbox. Exported for assertion in tests. */
export function buildExecArgv(opts: ForkOptions): string[] {
  const argv = ['--permission'];
  for (const p of opts.allowFsRead) argv.push(`--allow-fs-read=${p}`);
  for (const p of opts.allowFsWrite) argv.push(`--allow-fs-write=${p}`);
  argv.push(`--max-old-space-size=${opts.maxOldSpaceMb ?? 256}`);
  return argv;
}

export class ForkedWorkerChannel implements WorkerChannel {
  private readonly child: ChildProcess;
  private readonly killGraceMs: number;
  private closed = false;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly msgListeners = new Set<(frame: unknown) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(opts: ForkOptions) {
    this.killGraceMs = opts.killGraceMs ?? 2000;
    this.child = fork(opts.entry, [...(opts.args ?? [])], {
      execArgv: buildExecArgv(opts),
      // SCRUBBED env — no inheritance. Only the explicit identity vars the caller passes.
      env: { ...(opts.env ?? {}) },
      // No shared stdin; stdout/stderr IGNORED (not piped) so module output never reaches core's
      // streams AND an unconsumed pipe can't fill + block the child. Deliberate drained logging
      // can be added later. ipc is the only channel.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      // JSON serialization bounds what can cross the wire to our frame shape.
      serialization: 'json',
    });
    this.child.on('message', (m: unknown) => {
      for (const l of this.msgListeners) l(m);
    });
    this.child.once('exit', () => this.markClosed());
    this.child.once('error', () => this.markClosed());
  }

  /** The child PID (for logging / resource accounting). Undefined once exited. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  get open(): boolean {
    return !this.closed && this.child.connected;
  }

  send(frame: unknown): boolean {
    if (this.closed || !this.child.connected) return false;
    try {
      return this.child.send(frame as object);
    } catch {
      return false;
    }
  }

  onMessage(listener: (frame: unknown) => void): () => void {
    this.msgListeners.add(listener);
    return () => this.msgListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Graceful stop: SIGTERM, then SIGKILL after the grace period if still alive. */
  close(): void {
    if (this.closed) return;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      this.killTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill('SIGKILL');
        }
      }, this.killGraceMs);
      if (typeof this.killTimer.unref === 'function') this.killTimer.unref();
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.killTimer) clearTimeout(this.killTimer);
    for (const l of this.closeListeners) l();
  }
}
