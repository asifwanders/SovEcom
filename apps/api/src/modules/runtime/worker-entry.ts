/**
 * the forked worker entrypoint.
 *
 * This module runs INSIDE the sandboxed child process. It wires an {@link RpcPeer} over the
 * process IPC channel, builds the module-side {@link ModuleSdk} (the only way to reach core),
 * loads the module's own code, and hands it the SDK. Module code therefore has exactly one
 * channel to core — the SDK → broker — and no DB/secret/network access core trusts.
 *
 * `runWorker` is split out so the wiring is unit-testable in-process (in-memory channel + a fake
 * module); the bottom-of-file bootstrap wires the REAL process IPC and is exercised by the
 * fork-based integration tests. In production this file compiles to
 * `dist/modules/runtime/worker-entry.js` and is the fork target.
 */
import { RpcPeer } from './rpc';
import { createModuleSdk, type ModuleSdk } from './worker-sdk';
import type { WorkerChannel } from './worker-channel';

/** The contract a module must satisfy: a single `activate(sdk)` entrypoint. */
export interface SovecomModule {
  activate(sdk: ModuleSdk): void | Promise<void>;
}

function isModule(value: unknown): value is SovecomModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { activate?: unknown }).activate === 'function'
  );
}

/**
 * Wire the SDK over `channel`, load the module via `loadModule`, and call its `activate(sdk)`.
 * Returns the peer (for tests). Throws if the loaded module has no `activate` function.
 */
export async function runWorker(
  channel: WorkerChannel,
  loadModule: () => unknown,
): Promise<RpcPeer> {
  const peer = new RpcPeer(channel);
  const sdk = createModuleSdk(peer);
  const mod = loadModule();
  const resolved = isModule(mod)
    ? mod
    : isModule((mod as { default?: unknown })?.default)
      ? (mod as { default: SovecomModule }).default
      : null;
  if (!resolved) {
    throw new Error('module does not export an activate(sdk) function');
  }
  await resolved.activate(sdk);
  return peer;
}

/** A {@link WorkerChannel} over the forked child's process IPC. Used only in the real fork. */
export class ProcessWorkerChannel implements WorkerChannel {
  get open(): boolean {
    return Boolean(process.connected);
  }
  send(frame: unknown): boolean {
    if (!process.connected || !process.send) return false;
    try {
      return process.send(frame as object);
    } catch {
      return false;
    }
  }
  onMessage(listener: (frame: unknown) => void): () => void {
    const l = (m: unknown): void => listener(m);
    process.on('message', l);
    return () => process.off('message', l);
  }
  onClose(listener: () => void): () => void {
    const l = (): void => listener();
    process.once('disconnect', l);
    return () => process.off('disconnect', l);
  }
  close(): void {
    if (process.connected) process.disconnect();
  }
}

// ── bootstrap (only when this file is the forked entry) ──────────────────────────
/* istanbul ignore next — exercised by the fork integration tests, not unit-coverable */
if (require.main === module) {
  const main = process.env.SOVECOM_MODULE_MAIN;
  if (!main) {
    // eslint-disable-next-line no-console
    console.error('worker-entry: SOVECOM_MODULE_MAIN not set');
    process.exit(2);
  }
  const channel = new ProcessWorkerChannel();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  runWorker(channel, () => require(main)).catch((err: Error) => {
    // eslint-disable-next-line no-console
    console.error(`worker-entry: module activation failed: ${err.message}`);
    process.exit(1);
  });
}
