/**
 * secure THEME tarball ingest.
 *
 * Themes are declarative ASSETS — no worker, no permissions, no code execution. This service is
 * the theme-side twin of {@link ModuleIngestService}: it extracts an uploaded theme `.tgz` into
 * an ISOLATED per-call dir under `THEMES_DATA_PATH` using the SHARED {@link GuardedTarExtractor}
 * (the SAME audited zip-slip / symlink / size / file-count guards — no duplicated security code),
 * then reads + verifies its `sovecom.theme.json`. It NEVER executes code or `require()`s any
 * extracted file (the manifest is read as TEXT only).
 *
 * The install-mode commit/discard fork mirrors the module service (no overwrite / no auto-update):
 * the verified tree stays in an isolated temp dir until the
 * caller has claimed the `(tenant, name)` row, so a same-named re-install can never destroy +
 * replace an existing theme's on-disk files on its way to a 409.
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Injectable } from '@nestjs/common';
import { parseTemplate, type PageType, type ThemeTemplate } from '@sovecom/theme-sdk';
import { MANIFEST_MAX_BYTES } from './module-manifest';
import {
  parseAndVerifyThemeManifest,
  assertCoreCompatible,
  type ThemeManifest,
} from './theme-manifest';
import {
  GuardedTarExtractor,
  DEFAULT_GUARDED_TAR_LIMITS,
  type GuardedTarLimits,
} from './runtime/guarded-tar';

/** The manifest filename every theme must ship at its package root. */
export const THEME_MANIFEST_FILENAME = 'sovecom.theme.json';

/**
 * A validated set of wire-delivered page templates keyed by page type. Empty
 * for a tokens/settings-only theme. A `Partial` record because a theme supplies templates for only
 * the page types it declares.
 */
export type ThemeTemplateMap = Partial<Record<PageType, ThemeTemplate>>;

/**
 * AGGREGATE byte cap across ALL of a theme's declared templates — defence
 * against a many-small-templates DoS that bounds the public response. Each individual
 * template is already capped at `MANIFEST_MAX_BYTES` (64 KiB) by `parseTemplate`; the aggregate is
 * a small multiple of that (6×, ~384 KiB) — enough headroom for the at-most-6 page templates a
 * theme may ship, finite enough to keep the public `GET /store/v1/theme` payload bounded.
 */
export const THEME_TEMPLATES_AGGREGATE_MAX_BYTES = 6 * MANIFEST_MAX_BYTES;

/**
 * Theme ingestion caps — the shared tar guards PLUS the aggregate-template byte cap.
 * The aggregate cap is broken out as a tunable limit so tests can shrink it to assert
 * the guard fires (with template-count ≤ 6 and a per-file 64 KiB cap, the default 6× ceiling is
 * only reachable by files at the per-file cap — it is defence-in-depth, exactly like the serve-time
 * guard; a shrunk cap exercises it directly).
 */
export type ThemeIngestLimits = GuardedTarLimits & {
  /** Max total bytes across ALL of a theme's declared templates. */
  readonly aggregateTemplateBytes: number;
};

export const DEFAULT_THEME_INGEST_LIMITS: ThemeIngestLimits = {
  ...DEFAULT_GUARDED_TAR_LIMITS,
  aggregateTemplateBytes: THEME_TEMPLATES_AGGREGATE_MAX_BYTES,
};

export interface ThemeIngestResult {
  /** The verified, core-compatible manifest. */
  readonly manifest: ThemeManifest;
  /** Absolute path to the per-theme extraction temp dir (install mode only). */
  readonly extractedDir: string;
  /**
   * The validated wire-delivered page templates the theme ships, keyed by page type.
   * Empty `{}` for a tokens/settings-only theme. Every entry has already passed validation
   * (`.strict`, page-type enum, section/region bounds, byte cap), a page-match assert,
   * per-page-uniqueness and the aggregate-byte cap — so the caller persists data it can trust.
   */
  readonly templates: ThemeTemplateMap;
}

export interface ThemeIngestOptions {
  /** Inspect mode cleans up the temp dir before returning; install mode keeps it for commit. */
  readonly mode: 'inspect' | 'install';
}

/** A clear, catchable theme-ingest failure (distinct from manifest-verification errors). */
export class ThemeIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeIngestError';
  }
}

@Injectable()
export class ThemeIngestService {
  /** Storage ROOT for theme dirs — OUTSIDE /data/uploads, never /data/master.key. */
  private readonly themesRoot: string;
  private readonly limits: ThemeIngestLimits;
  /** The shared hardened extractor, configured to throw ThemeIngestError on a guard trip. */
  private readonly extractor: GuardedTarExtractor;

  /**
   * @param themesRoot override the base path (tests pass a temp dir). Defaults to
   *   `THEMES_DATA_PATH` env, then a sensible dev path.
   * @param limits override the caps (tests shrink them to assert mid-stream aborts).
   */
  constructor(themesRoot?: string, limits?: Partial<ThemeIngestLimits>) {
    this.themesRoot = path.resolve(themesRoot ?? process.env['THEMES_DATA_PATH'] ?? '/data/themes');
    this.limits = { ...DEFAULT_THEME_INGEST_LIMITS, ...limits };
    this.extractor = new GuardedTarExtractor((m) => new ThemeIngestError(m), this.limits);
  }

  /** The configured theme storage root (absolute). */
  get root(): string {
    return this.themesRoot;
  }

  /**
   * Ingest a theme `.tgz` (Buffer or local path) into a fresh isolated directory, then verify the
   * manifest. On any failure the partial directory is cleaned up and a clear error is thrown. In
   * `inspect` mode the directory is removed (verify-only); in `install` mode the verified tree stays
   * in its isolated temporary directory for the caller to {@link commitExtraction} or {@link discardExtraction}.
   */
  async ingest(
    tarball: Buffer | string,
    options: ThemeIngestOptions = { mode: 'install' },
  ): Promise<ThemeIngestResult> {
    // Compressed-size cap (cheap, up front); the streaming extraction bounds bytes a second time.
    if (Buffer.isBuffer(tarball)) {
      if (tarball.length > this.limits.maxCompressedBytes) {
        throw new ThemeIngestError(
          `tarball too large: ${tarball.length} compressed bytes exceeds the ` +
            `${this.limits.maxCompressedBytes}-byte cap`,
        );
      }
    } else {
      const stat = await fsp.stat(tarball).catch(() => {
        throw new ThemeIngestError(`tarball not found: ${tarball}`);
      });
      if (!stat.isFile()) {
        throw new ThemeIngestError(`tarball is not a regular file: ${tarball}`);
      }
      if (stat.size > this.limits.maxCompressedBytes) {
        throw new ThemeIngestError(
          `tarball too large: ${stat.size} compressed bytes exceeds the ` +
            `${this.limits.maxCompressedBytes}-byte cap`,
        );
      }
    }

    // Fresh isolated working dir UNDER the themes root (unpredictable, exclusive mkdtemp).
    await fsp.mkdir(this.themesRoot, { recursive: true });
    const workDir = await fsp.mkdtemp(path.join(this.themesRoot, '.ingest-'));
    const destRoot = path.resolve(workDir);

    try {
      await this.extractor.extract(tarball, destRoot);
      const manifest = await this.readAndVerifyManifest(destRoot);
      // Capture + validate any declared wire templates from the server's own extraction (never a
      // round-tripped payload). Any failure throws a ThemeIngestError → the install is rejected
      // loudly at the trust boundary, never deferred to render.
      const templates = await this.readAndValidateTemplates(destRoot, manifest);

      if (options.mode === 'inspect') {
        await this.rmrf(destRoot);
        return { manifest, extractedDir: destRoot, templates };
      }
      return { manifest, extractedDir: destRoot, templates };
    } catch (err) {
      await this.rmrf(destRoot);
      throw err;
    }
  }

  /**
   * Place a verified install-mode extraction at its stable per-theme dir `themes/<name>`. Call
   * ONLY after the `(tenant, name)` row has been claimed in the DB. Removes any stale orphan,
   * then atomically renames the temp dir into place. Returns the theme dir.
   */
  async commitExtraction(tempDir: string, name: string): Promise<string> {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new ThemeIngestError(`refusing to place theme with invalid name: ${name}`);
    }
    if (!GuardedTarExtractor.isContained(this.themesRoot, path.resolve(tempDir))) {
      throw new ThemeIngestError('refusing to place an extraction outside the themes root');
    }
    const themeDir = path.resolve(this.themesRoot, name);
    if (
      themeDir === this.themesRoot ||
      !GuardedTarExtractor.isContained(this.themesRoot, themeDir)
    ) {
      throw new ThemeIngestError(`refusing theme dir outside root: ${name}`);
    }
    // NOTE: the on-disk path is `themes/<name>`, NOT tenant-scoped — correct for single-tenant.
    // For future multi-tenant support, the layout should become `themes/<tenantId>/<name>`
    // to avoid cross-tenant conflicts.
    await this.rmrf(themeDir);
    await fsp.rename(path.resolve(tempDir), themeDir);
    return themeDir;
  }

  /**
   * Discard an install-mode extraction temp dir (the DB claim failed, or placement rolled back).
   * Containment-guarded best-effort removal — only ever removes one of OUR `.ingest-*` temps,
   * never `themes/<name>`.
   */
  async discardExtraction(tempDir: string): Promise<void> {
    const resolved = path.resolve(tempDir);
    if (
      resolved === this.themesRoot ||
      !GuardedTarExtractor.isContained(this.themesRoot, resolved)
    ) {
      return;
    }
    if (!path.basename(resolved).startsWith('.ingest-')) {
      return;
    }
    await this.rmrf(resolved);
  }

  /**
   * Remove a per-theme directory by NAME (failed-install cleanup + uninstall). The name MUST be
   * a validated manifest slug so it cannot contain a separator/traversal — re-resolved and
   * containment-asserted as defence in depth. Best-effort: never throws.
   */
  async removeThemeDir(name: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return;
    }
    const themeDir = path.resolve(this.themesRoot, name);
    if (
      themeDir === this.themesRoot ||
      !GuardedTarExtractor.isContained(this.themesRoot, themeDir)
    ) {
      return;
    }
    await this.rmrf(themeDir);
  }

  // ── manifest ───────────────────────────────────────────────────────────────

  /**
   * Read `sovecom.theme.json` from the extracted tree (bounded read — never more than
   * MANIFEST_MAX_BYTES), then run the theme verifier + the shared semver gate. A missing,
   * oversized, or invalid manifest raises a clear error. The file is read as TEXT — never required.
   */
  private async readAndVerifyManifest(destRoot: string): Promise<ThemeManifest> {
    const manifestPath = path.resolve(destRoot, THEME_MANIFEST_FILENAME);
    if (!GuardedTarExtractor.isContained(destRoot, manifestPath)) {
      throw new ThemeIngestError('manifest path escaped the extraction root');
    }

    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(manifestPath, 'r');
    } catch {
      throw new ThemeIngestError(
        `theme manifest "${THEME_MANIFEST_FILENAME}" not found at the package root`,
      );
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new ThemeIngestError(`theme manifest is not a regular file`);
      }
      if (stat.size > MANIFEST_MAX_BYTES) {
        throw new ThemeIngestError(
          `theme manifest too large: ${stat.size} bytes exceeds the ` +
            `${MANIFEST_MAX_BYTES}-byte cap`,
        );
      }
      const buf = Buffer.alloc(Math.min(stat.size, MANIFEST_MAX_BYTES));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const raw = buf.subarray(0, bytesRead).toString('utf8');

      const manifest = parseAndVerifyThemeManifest(raw);
      assertCoreCompatible(manifest);
      return manifest;
    } finally {
      await handle.close();
    }
  }

  // ── templates (SECURITY) ──────────────────────────────────────────────────

  /**
   * Capture + validate the theme's optional wire-delivered page templates from the extracted tree.
   * For each `templates[]` entry the manifest declares (the ALLOWLIST — no directory scanning of the
   * untrusted tree), this:
   *
   *   1. resolves the declared path INSIDE the extraction root and re-asserts containment with the
   *      same `GuardedTarExtractor.isContained` guard the manifest read uses — a path that escapes
   *      (a symlink that resolved out, or a slipped `..`) is refused (defence-in-depth over the
   *      manifest-schema path regex);
   *   2. reads it as TEXT with the same bounded read as the manifest (never `require`/import/eval);
   *   3. runs `parseTemplate(raw)` — the SDK validator (`.strict`, page-type enum, MAX_SECTIONS,
   *      section-type slug, region count + MAX_REGION_DEPTH, per-template byte cap);
   *   4. asserts the parsed `template.page` EQUALS the declared `page` (no page-type spoofing);
   *   5. enforces per-page-uniqueness (also gated by the manifest schema) and the AGGREGATE byte cap
   *      across every template (bounds the widened public response).
   *
   * ANY failure throws a `ThemeIngestError` — the whole install is rejected with a clear error. A
   * theme that declares no templates returns `{}` (a tokens/settings-only theme is valid). NO code
   * execution anywhere — templates are DATA validated by pure functions.
   */
  private async readAndValidateTemplates(
    destRoot: string,
    manifest: ThemeManifest,
  ): Promise<ThemeTemplateMap> {
    const decls = manifest.templates ?? [];
    if (decls.length === 0) {
      return {};
    }

    const out: ThemeTemplateMap = {};
    let aggregateBytes = 0;

    for (const decl of decls) {
      // Per-page uniqueness — also enforced by the manifest schema, re-checked here as the
      // record is the keyed persistence shape (a duplicate would silently overwrite otherwise).
      if (out[decl.page] !== undefined) {
        throw new ThemeIngestError(`theme declares more than one template for page "${decl.page}"`);
      }

      // 1. Resolve INSIDE the extraction root + re-assert containment (defence over the schema regex).
      const templatePath = path.resolve(destRoot, decl.path);
      if (!GuardedTarExtractor.isContained(destRoot, templatePath)) {
        throw new ThemeIngestError(
          `template path for page "${decl.page}" escaped the extraction root`,
        );
      }

      // 2. Bounded TEXT read (never require/import). A missing/oversized/irregular file rejects.
      const raw = await this.readBoundedTemplateFile(templatePath, decl.page);
      aggregateBytes += Buffer.byteLength(raw, 'utf8');
      if (aggregateBytes > this.limits.aggregateTemplateBytes) {
        throw new ThemeIngestError(
          `theme templates exceed the aggregate ${this.limits.aggregateTemplateBytes}-byte cap`,
        );
      }

      // 3. Validate via the SDK (pure). 4. Assert the page matches the declaration.
      let template: ThemeTemplate;
      try {
        template = parseTemplate(raw);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new ThemeIngestError(`template for page "${decl.page}" is invalid: ${detail}`);
      }
      if (template.page !== decl.page) {
        throw new ThemeIngestError(
          `template page mismatch: file declares page "${template.page}" but the manifest ` +
            `declares it for page "${decl.page}"`,
        );
      }

      out[decl.page] = template;
    }

    return out;
  }

  /**
   * Read a declared template file as TEXT with the same bounded read as the manifest — open, assert
   * regular file, cap at `MANIFEST_MAX_BYTES`, read at most that many bytes. NEVER `require`d.
   */
  private async readBoundedTemplateFile(templatePath: string, page: string): Promise<string> {
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(templatePath, 'r');
    } catch {
      throw new ThemeIngestError(`template file for page "${page}" not found at the declared path`);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new ThemeIngestError(`template for page "${page}" is not a regular file`);
      }
      if (stat.size > MANIFEST_MAX_BYTES) {
        throw new ThemeIngestError(
          `template for page "${page}" too large: ${stat.size} bytes exceeds the ` +
            `${MANIFEST_MAX_BYTES}-byte cap`,
        );
      }
      const buf = Buffer.alloc(Math.min(stat.size, MANIFEST_MAX_BYTES));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  // ── util ───────────────────────────────────────────────────────────────────

  private async rmrf(target: string): Promise<void> {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {
      /* best-effort cleanup — never mask the original error */
    });
  }
}
