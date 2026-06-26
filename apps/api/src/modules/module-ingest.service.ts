/**
 * secure tarball INGEST.
 *
 * THE single riskiest path in the project: supply-chain / zip-slip / zip-bomb. This service
 * extracts an uploaded/local module `.tgz` into an ISOLATED per-call directory under
 * `MODULES_DATA_PATH`, then reads + verifies its `sovecom.module.json`. It NEVER:
 *   - fetches over the network (live npm/git is a separate, later, dual-reviewed chunk);
 *   - executes module code, runs `npm install`, or runs any lifecycle script;
 *   - `require()`s / imports any extracted file (the manifest is read as TEXT only).
 *
 * The security-hardened extraction has been hoisted into the shared
 * {@link GuardedTarExtractor} so the same audited guards extract both modules and themes
 * (one path, no duplicated security code). This service composes that extractor with the
 * module-specific manifest filename + verifier and the per-module dir lifecycle. Every guard
 * lives in `guarded-tar.ts` and is individually tested via the module-ingest spec.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Injectable } from '@nestjs/common';
import {
  MANIFEST_MAX_BYTES,
  parseAndVerifyManifest,
  assertCoreCompatible,
  type ModuleManifest,
} from './module-manifest';
import {
  GuardedTarExtractor,
  DEFAULT_GUARDED_TAR_LIMITS,
  type GuardedTarLimits,
} from './runtime/guarded-tar';

/** The manifest filename every module must ship at its package root. */
export const MODULE_MANIFEST_FILENAME = 'sovecom.module.json';

/**
 * Ingestion caps. Generous for real modules, hard ceilings against bombs.
 * All are enforced DURING extraction by the shared {@link GuardedTarExtractor}.
 */
export type IngestLimits = GuardedTarLimits;

export const DEFAULT_INGEST_LIMITS: IngestLimits = DEFAULT_GUARDED_TAR_LIMITS;

export interface IngestResult {
  /** The verified, core-compatible manifest. */
  readonly manifest: ModuleManifest;
  /** Absolute path to the per-module extraction dir (install mode only). */
  readonly extractedDir: string;
}

export interface IngestOptions {
  /**
   * Inspect mode cleans up the extraction dir before returning (verify-only). Install mode
   * keeps a per-module dir named by `manifest.name`. DB persistence is handled separately.
   */
  readonly mode: 'inspect' | 'install';
}

/** A clear, catchable ingest failure (distinct from manifest-verification errors). */
export class ModuleIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleIngestError';
  }
}

@Injectable()
export class ModuleIngestService {
  /** Storage ROOT for module dirs — OUTSIDE /data/uploads, never /data/master.key. */
  private readonly modulesRoot: string;
  private readonly limits: IngestLimits;
  /** The shared hardened extractor, configured to throw ModuleIngestError on a guard trip. */
  private readonly extractor: GuardedTarExtractor;

  /**
   * @param modulesRoot Override the base path (tests pass a temp dir). Defaults to
   *   `MODULES_DATA_PATH` env, then a sensible dev path.
   * @param limits Override the caps (tests shrink them to assert mid-stream aborts).
   */
  constructor(modulesRoot?: string, limits?: Partial<IngestLimits>) {
    this.modulesRoot = path.resolve(
      modulesRoot ?? process.env['MODULES_DATA_PATH'] ?? '/data/modules',
    );
    this.limits = { ...DEFAULT_INGEST_LIMITS, ...limits };
    this.extractor = new GuardedTarExtractor((m) => new ModuleIngestError(m), this.limits);
  }

  /** The configured module storage root (absolute). */
  get root(): string {
    return this.modulesRoot;
  }

  /**
   * Ingest a `.tgz` (uploaded Buffer or a local file path) into a FRESH isolated dir, then
   * verify the manifest. On any failure the partial dir is cleaned up and a clear error is
   * thrown.
   *
   * In `inspect` mode the dir is removed before returning (verify-only). In `install` mode the
   * verified tree is LEFT in its isolated temp dir and its path returned as `extractedDir` —
   * the caller must then either {@link commitExtraction} it into the per-module dir (AFTER it
   * has atomically claimed the `(tenant, name)` row in the DB) or {@link discardExtraction} it.
   * Ingest deliberately does NOT place the tree itself: if it overwrote `modules/<name>` before
   * the DB claim, a second install of a DIFFERENT tarball with the same `name` would destroy
   * and replace an already-installed module's files and THEN fail the uniqueness check — a
   * silent content swap on the error path that must be prevented by atomicity.
   */
  async ingest(
    tarball: Buffer | string,
    options: IngestOptions = { mode: 'install' },
  ): Promise<IngestResult> {
    // Compressed-size cap (cheap, up front). For a Buffer we know the length immediately;
    // for a path we stat it. The streaming extraction ALSO bounds bytes a second time.
    if (Buffer.isBuffer(tarball)) {
      if (tarball.length > this.limits.maxCompressedBytes) {
        throw new ModuleIngestError(
          `tarball too large: ${tarball.length} compressed bytes exceeds the ` +
            `${this.limits.maxCompressedBytes}-byte cap`,
        );
      }
    } else {
      const stat = await fsp.stat(tarball).catch(() => {
        throw new ModuleIngestError(`tarball not found: ${tarball}`);
      });
      if (!stat.isFile()) {
        throw new ModuleIngestError(`tarball is not a regular file: ${tarball}`);
      }
      if (stat.size > this.limits.maxCompressedBytes) {
        throw new ModuleIngestError(
          `tarball too large: ${stat.size} compressed bytes exceeds the ` +
            `${this.limits.maxCompressedBytes}-byte cap`,
        );
      }
    }

    // Fresh isolated working dir UNDER the modules root (never a shared/temp location that
    // another caller could race). `mkdtemp` gives an unpredictable, exclusive directory.
    await fsp.mkdir(this.modulesRoot, { recursive: true });
    const workDir = await fsp.mkdtemp(path.join(this.modulesRoot, '.ingest-'));
    const destRoot = path.resolve(workDir);

    try {
      await this.extractor.extract(tarball, destRoot);
      const manifest = await this.readAndVerifyManifest(destRoot);

      if (options.mode === 'inspect') {
        await this.rmrf(destRoot);
        return { manifest, extractedDir: destRoot };
      }

      // Install mode: leave the verified tree in its isolated temp dir and hand the path back.
      // The caller claims the DB row FIRST, then calls commitExtraction (place) or
      // discardExtraction (clean up) — we never touch `modules/<name>` here.
      return { manifest, extractedDir: destRoot };
    } catch (err) {
      // Clean up the partial extraction — no orphaned files on any error path.
      await this.rmrf(destRoot);
      throw err;
    }
  }

  /**
   * Place a verified install-mode extraction (the temp dir returned by {@link ingest}) at its
   * stable per-module dir `modules/<name>`. Call this ONLY after the `(tenant, name)` row has
   * been claimed in the DB, so we know no other install legitimately owns the name. Removes any
   * stale orphan dir, then atomically renames the temp dir into place. Returns the module dir.
   */
  async commitExtraction(tempDir: string, name: string): Promise<string> {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new ModuleIngestError(`refusing to place module with invalid name: ${name}`);
    }
    // The temp dir must be one of our own isolated extraction dirs under the root.
    if (!GuardedTarExtractor.isContained(this.modulesRoot, path.resolve(tempDir))) {
      throw new ModuleIngestError('refusing to place an extraction outside the modules root');
    }
    const moduleDir = path.resolve(this.modulesRoot, name);
    if (
      moduleDir === this.modulesRoot ||
      !GuardedTarExtractor.isContained(this.modulesRoot, moduleDir)
    ) {
      throw new ModuleIngestError(`refusing module dir outside root: ${name}`);
    }
    // NOTE: the on-disk path is `modules/<name>`, NOT tenant-scoped. In v1 (single-tenant)
    // that is correct: the caller has already claimed the sole `(tenant, name)` row, so no
    // other install owns this name and this `rmrf` only clears a stale orphan. When
    // multi-tenant lands, this `rmrf(moduleDir)` becomes a CROSS-TENANT
    // destruction primitive (tenant B's install would wipe tenant A's identically-named module)
    // — the layout MUST become `modules/<tenantId>/<name>` and these methods MUST take tenantId.
    await this.rmrf(moduleDir);
    await fsp.rename(path.resolve(tempDir), moduleDir);
    return moduleDir;
  }

  /**
   * Discard an install-mode extraction temp dir (the DB claim failed, or placement rolled
   * back). Containment-guarded best-effort removal — never touches `modules/<name>`.
   */
  async discardExtraction(tempDir: string): Promise<void> {
    const resolved = path.resolve(tempDir);
    if (
      resolved === this.modulesRoot ||
      !GuardedTarExtractor.isContained(this.modulesRoot, resolved)
    ) {
      return;
    }
    // Only ever remove one of OUR isolated extraction temps (`mkdtemp('.ingest-…')`). Refuse to
    // rmrf a real module dir even if a future caller mistakenly passes `modules/<name>` here.
    if (!path.basename(resolved).startsWith('.ingest-')) {
      return;
    }
    await this.rmrf(resolved);
  }

  // ── manifest ───────────────────────────────────────────────────────────────

  /**
   * Read `sovecom.module.json` from the extracted tree (bounded read — never more than
   * MANIFEST_MAX_BYTES), then run the chunk-A verifier + semver gate. A missing, oversized,
   * or invalid manifest raises a clear error. The file is read as TEXT — never required.
   */
  private async readAndVerifyManifest(destRoot: string): Promise<ModuleManifest> {
    const manifestPath = path.resolve(destRoot, MODULE_MANIFEST_FILENAME);
    // Containment is guaranteed by construction, but assert anyway (defence in depth).
    if (!GuardedTarExtractor.isContained(destRoot, manifestPath)) {
      throw new ModuleIngestError('manifest path escaped the extraction root');
    }

    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(manifestPath, 'r');
    } catch {
      throw new ModuleIngestError(
        `module manifest "${MODULE_MANIFEST_FILENAME}" not found at the package root`,
      );
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new ModuleIngestError(`module manifest is not a regular file`);
      }
      if (stat.size > MANIFEST_MAX_BYTES) {
        throw new ModuleIngestError(
          `module manifest too large: ${stat.size} bytes exceeds the ` +
            `${MANIFEST_MAX_BYTES}-byte cap`,
        );
      }
      // Bounded read: never pull more than the cap, even if the file grew under us.
      const buf = Buffer.alloc(Math.min(stat.size, MANIFEST_MAX_BYTES));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const raw = buf.subarray(0, bytesRead).toString('utf8');

      // chunk-A verifiers — these surface their own descriptive errors.
      const manifest = parseAndVerifyManifest(raw);
      assertCoreCompatible(manifest);
      return manifest;
    } finally {
      await handle.close();
    }
  }

  /**
  /**
   * Remove a per-module directory by module NAME (failed-install cleanup + uninstall).
   * The name MUST be a validated manifest slug (`^[a-z][a-z0-9-]*$`) so it cannot contain
   * a separator or traversal — but we re-resolve and assert containment under
   * the modules root as defence in depth, and refuse a name that resolves to the root itself.
   * Best-effort (a missing dir is fine): never throws, so a DB cleanup path is never masked.
   */
  async removeModuleDir(name: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      // A non-slug name can never have produced a module dir; refuse to touch the FS.
      return;
    }
    const moduleDir = path.resolve(this.modulesRoot, name);
    if (
      moduleDir === this.modulesRoot ||
      !GuardedTarExtractor.isContained(this.modulesRoot, moduleDir)
    ) {
      return;
    }
    await this.rmrf(moduleDir);
  }

  // ── util ───────────────────────────────────────────────────────────────────

  private async rmrf(target: string): Promise<void> {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup — never mask the original error */
    });
  }
}
