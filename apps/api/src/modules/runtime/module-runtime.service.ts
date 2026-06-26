/**
 * ModuleRuntimeService: the public face of the runtime that
 * the admin flow calls. `enable` starts an installed module in a sandboxed worker and wires the
 * broker to it with the module's persisted grants + tenant; `disable` stops it. Crash isolation,
 * permission/tenant gating, and egress mediation all come from the composed pieces below.
 *
 * adds a liveness watchdog (ping timeout → stop + persist
 * disabled) and the `enable`/`disable` enabled-flag persistence via the repo. The watchdog runs
 * on a ~30 s interval (unrefd so it doesn't keep the process alive); `checkLiveness()` is
 * exposed as a method so it can be called synchronously in unit tests.
 *
 * The worker fork itself is built by the injected {@link WorkerHost}'s channel factory (a real
 * {@link ForkedWorkerChannel} in production, a fake in tests), so this service's orchestration —
 * load the row, assemble the context, compute the sandbox paths, start, register the broker — is
 * unit-testable without spawning a process.
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';

import type { ModulePermission } from '../module-manifest';
import { ModulesRepository } from '../modules.repository';
import { ModuleBroker, type BrokerContext } from './module-broker';
import { WorkerHost, type WorkerSpec } from './worker-host';
import { ModuleDbProvisioner } from './module-db.provisioner';
import { ModuleSqlExecutor } from './module-sql.executor';
import {
  ALLOWED_MODULE_RESPONSE_HEADERS,
  DEFAULT_RESPONSE_MEDIA_TYPE,
  MAX_MODULE_RESPONSE_BYTES,
  MODULE_HTTP_METHOD,
  SAFE_RESPONSE_MEDIA_TYPES,
  type ModuleHttpRequest,
  type ModuleHttpResponse,
} from './module-http';

/** Interval between liveness pings (ms). Unrefd so it doesn't hold the event loop open. */
const LIVENESS_INTERVAL_MS = 30_000;
/** Timeout for a single ping request to a worker (ms). A hung worker won't respond. */
const PING_TIMEOUT_MS = 5_000;

/** Where installed module code lives on disk. */
function modulesRoot(): string {
  return path.resolve(process.env.MODULES_DATA_PATH ?? '/data/modules');
}

/** The compiled forked entry (this file's dir in dist → worker-entry.js). */
function workerEntryPath(): string {
  return path.join(__dirname, 'worker-entry.js');
}

@Injectable()
export class ModuleRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModuleRuntimeService.name);
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  /** Guard against overlapping watchdog runs (e.g. many slow workers). */
  private livenessRunning = false;

  constructor(
    private readonly repo: ModulesRepository,
    private readonly host: WorkerHost,
    private readonly broker: ModuleBroker,
    private readonly provisioner: ModuleDbProvisioner,
    private readonly executor: ModuleSqlExecutor,
  ) {}

  onModuleInit(): void {
    // Skip the background timer in test environments (integration tests that do NOT use the
    // enable happy-path don't want a background ping loop interfering).
    if (process.env.NODE_ENV === 'test') return;
    this.livenessTimer = setInterval(() => void this.checkLiveness(), LIVENESS_INTERVAL_MS);
    if (typeof this.livenessTimer.unref === 'function') this.livenessTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /**
   * Ping every running worker. A worker that fails to respond within {@link PING_TIMEOUT_MS}
   * is treated as hung: it is disabled (worker stopped + DB connection closed) and the
   * `enabled` flag is persisted to false so it is not auto-started on the next process start.
   * Exposed as a public method so unit tests can drive it without waiting for the interval.
   * Guards against overlapping runs.
   */
  async checkLiveness(): Promise<void> {
    if (this.livenessRunning) return;
    this.livenessRunning = true;
    try {
      const handles = this.host.list().filter((h) => h.status === 'running');
      await Promise.all(
        handles.map(async (handle) => {
          const { tenantId, name } = handle.identity;
          try {
            await Promise.race([
              handle.peer.request('ping', null),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('ping timeout')), PING_TIMEOUT_MS),
              ),
            ]);
          } catch {
            this.logger.warn(
              `liveness check failed for ${tenantId}/${name} — stopping unresponsive worker`,
            );
            // disable() stops + closes the worker AND persists enabled=false (best-effort).
            await this.disable(tenantId, name);
          }
        }),
      );
    } finally {
      this.livenessRunning = false;
    }
  }

  /**
   * Start a sandboxed worker for an installed module: provision its DB home (idempotent), open a
   * dedicated connection authenticated as its own low-privilege role, then start the worker and
   * wire the broker. Throws 404 if the module is not installed for the tenant. On a failure after
   * the DB connection opens, the connection is closed so we don't leak it.
   */
  async enable(tenantId: string, name: string): Promise<void> {
    const row = await this.repo.findByName(tenantId, name);
    if (!row) throw new NotFoundException(`module not installed: ${name}`);

    const ctx: BrokerContext = {
      tenantId,
      moduleName: row.name,
      grantedPermissions: new Set((row.grantedPermissions as ModulePermission[]) ?? []),
      httpAllowlist: new Set(readAllowlist(row.settings)),
    };
    // DB home first: provision the schema/role (idempotent), mint an ephemeral credential, and
    // open the module's dedicated connection — so `tables.*` works the moment the worker runs.
    await this.provisioner.provision(row.name);
    const password = await this.provisioner.rotateCredential(row.name);
    this.executor.open(row.name, password);

    try {
      // Use the STORED name (validated slug at install) for the sandbox paths — never the raw
      // caller argument — and re-assert it in buildSpec (defence in depth for the fs boundary).
      const handle = this.host.start(this.buildSpec(tenantId, row.name));
      // Register the broker BEFORE the worker can call (start is sync; the fork still has to boot).
      this.broker.registerOn(handle.peer, ctx);
    } catch (err) {
      await this.executor.close(row.name).catch(() => undefined);
      throw err;
    }
    // Persist the enabled state so a process restart can see the intent.
    await this.repo.setEnabled(tenantId, row.name, true);
  }

  /**
   * Stop a module's worker + close its DB connection (disable). Data/schema are PRESERVED (ADR
   * 0057 §6). No-op if the worker is not running (so a disable endpoint on a stopped module
   * returns 204 without error — the intent is already satisfied).
   */
  async disable(tenantId: string, name: string): Promise<void> {
    this.host.stop(tenantId, name);
    await this.executor.close(name);
    // Persist the disabled state. Best-effort: if the module row has already been deleted (e.g.
    // uninstall path) this silently does nothing.
    await this.repo.setEnabled(tenantId, name, false).catch(() => undefined);
  }

  /** True if a worker is currently running for this module. */
  isRunning(tenantId: string, name: string): boolean {
    return this.host.get(tenantId, name)?.status === 'running';
  }

  /**
   * Proxy a mounted HTTP request to the module's worker. Throws 404 if the module
   * is not enabled for the tenant. The worker's response is UNTRUSTED — it is bounded here:
   * status clamped, headers reduced to a safe allowlist, body size-capped.
   */
  async handleHttp(name: string, req: ModuleHttpRequest): Promise<ModuleHttpResponse> {
    const handle = this.host.get(req.tenantId, name);
    if (!handle || handle.status !== 'running') {
      throw new NotFoundException(`module not enabled: ${name}`);
    }
    const raw = await handle.peer.request(MODULE_HTTP_METHOD, req);
    return boundResponse(raw);
  }

  private buildSpec(tenantId: string, name: string): WorkerSpec {
    // Defence in depth: the name forms fs-grant PATHS, so re-assert the install-time slug
    // (`^[a-z][a-z0-9-]*$`) here and confirm the resolved module dir stays under the root — a
    // sandbox boundary must never rely on validation enforced two layers away.
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(`refusing to run module with invalid name: ${name}`);
    }
    const root = modulesRoot();
    const moduleDir = path.resolve(root, name);
    if (moduleDir !== path.join(root, name) || !moduleDir.startsWith(root + path.sep)) {
      throw new Error(`refusing module dir outside the modules root: ${name}`);
    }
    return {
      tenantId,
      name,
      entry: workerEntryPath(),
      // READ: the compiled runtime (entry + SDK), the node_modules trees the worker entry resolves
      // its own deps through, and ONLY this module's dir — never other modules' dirs or the master
      // key. Under a pnpm workspace the worker-entry's `require('@sovecom/module-sdk')` (and that
      // SDK's `zod`/`semver`) resolve through SYMLINKS in the api app's `node_modules` and the
      // `packages/*` workspace dirs before reaching the hoisted `.pnpm` store — Node's permission
      // model checks each traversed path, so every link dir on that chain must be readable or the
      // worker dies at load with ERR_ACCESS_DENIED. These dirs hold the runtime's OWN dependency
      // graph (read-only), not module-author code; they widen no module-reachable surface.
      allowFsRead: [path.dirname(workerEntryPath()), ...runtimeReadRoots(), moduleDir],
      // WRITE: nothing. 3.3c modules have no filesystem-write use (persistence is write:own_tables
      // DB-backed). Granting no write also removes any symlink-from-a-writable-dir vector.
      allowFsWrite: [],
      env: {
        SOVECOM_MODULE_MAIN: path.join(moduleDir, 'index.js'),
        SOVECOM_MODULE: name,
        SOVECOM_TENANT: tenantId,
        NODE_ENV: process.env.NODE_ENV ?? 'production',
      },
      maxOldSpaceMb: 256,
    };
  }
}

/**
 * The node_modules / workspace dirs the worker entry resolves the runtime's OWN dependency graph
 * through. The worker forks `<apiRoot>/dist/modules/runtime/worker-entry.js`, which requires the
 * compiled `@sovecom/module-sdk` (+ its `zod`/`semver`). Under pnpm those resolve via symlinks in:
 *   - the cwd's `node_modules` (where the hoisted `.pnpm` store lives),
 *   - the api app's own `node_modules` (the workspace package's link farm),
 *   - the monorepo `packages` dir (the `@sovecom/*` workspace sources/dist + their `node_modules`).
 * Node's permission model authorizes by traversed path (not just realpath), so all three link roots
 * must be granted. They are READ-only and contain no module-author code. Duplicates/non-existent
 * paths are harmless (the flag is additive), so we de-dupe and keep this best-effort.
 */
function runtimeReadRoots(): string[] {
  const roots = new Set<string>();
  // Always grant the cwd node_modules (the hoisted `.pnpm` store when the api runs from its app root).
  roots.add(path.resolve(process.cwd(), 'node_modules'));
  // workerEntryPath() = `<apiRoot>/dist/modules/runtime/worker-entry.js`, so apiRoot is FOUR `..`
  // segments up (runtime → modules → dist → apiRoot); the monorepo root is TWO levels above apiRoot
  // (apps/api → apps → repoRoot), and its `packages` holds the @sovecom/* workspace deps.
  const apiRoot = path.resolve(workerEntryPath(), '..', '..', '..', '..');
  const repoRoot = path.resolve(apiRoot, '..', '..');
  // FAIL-CLOSED: only widen to the workspace dep roots when the computed layout actually matches
  // (apiRoot basename `api` + its `dist/modules/runtime` present, and repoRoot is not the FS root).
  // An unexpected layout (entry moved / shallow __dirname) falls back to the cwd node_modules alone
  // rather than silently granting an over-broad `/packages` // `/node_modules` (review S-1).
  const layoutOk =
    repoRoot !== path.sep &&
    path.basename(apiRoot) === 'api' &&
    fs.existsSync(path.join(apiRoot, 'dist', 'modules', 'runtime'));
  if (layoutOk) {
    roots.add(path.join(apiRoot, 'node_modules'));
    roots.add(path.join(repoRoot, 'packages'));
    roots.add(path.join(repoRoot, 'node_modules'));
  }
  return [...roots];
}

/** Read an admin-configured outbound host allowlist from the module's settings bag. */
function readAllowlist(settings: unknown): string[] {
  const raw = (settings as { httpAllowlist?: unknown } | null)?.httpAllowlist;
  if (!Array.isArray(raw)) return [];
  return raw.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase());
}

/**
 * Bound an UNTRUSTED worker HTTP response: require an object, clamp status to a valid code (else
 * 502), reduce headers to the safe allowlist (drops set-cookie/auth/security headers + any
 * non-string), and cap the body size (oversize → 502). A malformed response becomes a 502.
 */
function boundResponse(raw: unknown): ModuleHttpResponse {
  if (typeof raw !== 'object' || raw === null) {
    return { status: 502, body: 'module returned an invalid response' };
  }
  const r = raw as { status?: unknown; headers?: unknown; body?: unknown };
  const status =
    typeof r.status === 'number' && Number.isInteger(r.status) && r.status >= 100 && r.status <= 599
      ? r.status
      : 502;
  const headers: Record<string, string> = {};
  if (typeof r.headers === 'object' && r.headers !== null) {
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      // Allowlisted key, string value, and NO control chars (a CRLF would be response-splitting).
      if (
        ALLOWED_MODULE_RESPONSE_HEADERS.has(k.toLowerCase()) &&
        typeof v === 'string' &&
        !/[\r\n\0]/.test(v)
      ) {
        headers[k.toLowerCase()] = v;
      }
    }
  }
  // Force a SAFE content-type: a module's bytes are served on the API origin, so never let them
  // render as active HTML/SVG. Unknown/omitted/active types → octet-stream (downloads, not renders).
  const declaredMedia = (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (!SAFE_RESPONSE_MEDIA_TYPES.has(declaredMedia)) {
    headers['content-type'] = DEFAULT_RESPONSE_MEDIA_TYPE;
  }
  let body: string | undefined;
  if (typeof r.body === 'string') {
    if (Buffer.byteLength(r.body, 'utf8') > MAX_MODULE_RESPONSE_BYTES) {
      return { status: 502, body: 'module response too large' };
    }
    body = r.body;
  }
  return { status, headers, body };
}
