/**
 * ThemesService — orchestrates install, activate, list, settings, and uninstall.
 * SECURITY-relevant: reuses the hardened tar extractor; themes execute no code.
 *
 * Orchestrates flows over the theme verifier and the shared-extractor-backed {@link ThemeIngestService}.
 * Themes are declarative assets — there is no worker, no permission grant, no enable/disable;
 * activation is the only runtime state. Security properties enforced here:
 *
 *   1. No code execution — install only extracts + verifies + persists.
 *   2. The manifest is re-verified on install from the server's own re-extraction (never a
 *      round-tripped client payload).
 *   3. Tenant isolation — every persistence call is tenant-scoped via the repository.
 *   4. No orphaned directories — a failed install removes the extracted per-theme directory; uninstall
 *      removes it after deleting the row.
 *   5. Double-install is a 409 (no auto-update / no update endpoint).
 *
 * Install ordering is security-critical: claim the `(tenant, name)` row BEFORE placing files,
 * so a same-named re-install can never overwrite an existing theme's on-disk files.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ThemesRepository,
  ThemeAlreadyInstalledError,
  type InstallThemeInput,
} from './themes.repository';
import {
  ThemeIngestService,
  THEME_TEMPLATES_AGGREGATE_MAX_BYTES,
  type ThemeTemplateMap,
} from './theme-ingest.service';
import type { ThemeManifest } from './theme-manifest';
import type { InstalledTheme } from '../database/schema/installed_themes';
import type { AnalyticsSettings } from '../taxes/tenant-settings.service';

/** The projected row returned to the admin (manifest blob NOT echoed wholesale). */
export interface InstalledThemeView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly slots: string[];
  readonly settings: Record<string, unknown>;
  readonly isActive: boolean;
  readonly installedAt: Date;
}

/**
 * The public store view of the active theme (name + version + settings + optional wire templates).
 * `templates` is additive: absent or `{}` for a theme that ships none — the storefront then
 * renders the bundled set by name. NEVER leaks the manifest, on-disk path, or any other tenant's theme.
 */
export interface ActiveThemeView {
  readonly name: string;
  readonly version: string;
  readonly settings: Record<string, unknown>;
  readonly templates?: ThemeTemplateMap;
  /**
   * Storefront analytics config — attached by the store theme controller
   * from `tenants.settings.analytics`, not by the theme itself. Piggybacks this public read so the
   * storefront layout (which already fetches it every render) can emit analytics scripts.
   */
  readonly analytics?: AnalyticsSettings;
}

@Injectable()
export class ThemesService {
  constructor(
    private readonly repo: ThemesRepository,
    private readonly ingest: ThemeIngestService,
  ) {}

  /**
   * Install a theme. Ordering is security-critical (no overwrite / no auto-update):
   *   1. Re-ingest in install-mode (re-extract + re-verify — never trust a round-tripped
   *      manifest). The verified tree stays in an isolated temporary directory; nothing is placed yet.
   *   2. INSERT the row (the atomic `(tenant, name)` claim). A conflict → discard the temp dir
   *      and 409 — the existing install's files are never touched.
   *   3. Only after the claim succeeds, COMMIT the extraction (place it at `themes/<name>`).
   *      If placement fails, roll the row back so we never register a theme with no files.
   *   A fresh install is always INACTIVE (the admin activates it explicitly).
   */
  async install(tenantId: string, tarball: Buffer): Promise<InstalledThemeView> {
    // 1. Re-extract + re-verify into an isolated temporary directory. The manifest and validated
    //    templates from here on are the server's own, not the client's. `extractedDir` is not
    //    yet placed at themes/<name>. A bad/oversize/spoofed template already rejected the install
    //    inside `ingest` — what reaches here is trusted data.
    const { manifest, extractedDir, templates } = await this.ingest.ingest(tarball, {
      mode: 'install',
    });

    // 2. Claim the (tenant, name) row FIRST. On conflict or any DB error, discard the temp
    //    extraction and NEVER touch an existing install's on-disk dir.
    let row: InstalledTheme;
    try {
      const input: InstallThemeInput = {
        tenantId,
        name: manifest.name,
        version: manifest.version,
        source: 'upload',
        manifest,
        templates,
      };
      row = await this.repo.insert(input);
    } catch (err) {
      await this.ingest.discardExtraction(extractedDir);
      if (err instanceof ThemeAlreadyInstalledError) {
        // No auto-update / no silent overwrite. Refuse and leave existing state intact.
        throw new ConflictException('theme already installed');
      }
      throw err;
    }

    // 3. Row claimed — place the verified files. If placement fails, roll the row back so the
    //    registry never references a theme whose files were never written. Both cleanups are
    //    best-effort and MUST NOT mask the original placement error.
    try {
      await this.ingest.commitExtraction(extractedDir, manifest.name);
    } catch (err) {
      await this.repo.deleteByName(tenantId, manifest.name).catch(() => undefined);
      await this.ingest.discardExtraction(extractedDir).catch(() => undefined);
      throw err;
    }

    return ThemesService.toView(row);
  }

  /**
   * Activate the named theme (and deactivate any previously-active one — the repo does this in a
   * single transaction to satisfy the single-active-theme constraint). 404 if the theme is not
   * installed for this tenant.
   */
  async activate(tenantId: string, name: string): Promise<InstalledThemeView> {
    const row = await this.repo.activate(tenantId, name);
    if (!row) {
      throw new NotFoundException(`theme not installed: ${name}`);
    }
    return ThemesService.toView(row);
  }

  /** List the tenant's installed themes as a projected view (slots pulled from the manifest). */
  async list(tenantId: string): Promise<InstalledThemeView[]> {
    const rows = await this.repo.list(tenantId);
    return rows.map((r) => ThemesService.toView(r));
  }

  /**
   * Replace the named theme's settings bag. 404 if the theme is not installed for this tenant.
   * (Replace semantics — the PATCH supplies the full settings object; see the repo note.)
   */
  async setSettings(
    tenantId: string,
    name: string,
    settings: Record<string, unknown>,
  ): Promise<InstalledThemeView> {
    const row = await this.repo.setSettings(tenantId, name, settings);
    if (!row) {
      throw new NotFoundException(`theme not installed: ${name}`);
    }
    return ThemesService.toView(row);
  }

  /**
   * Uninstall: delete the tenant's row, then remove the per-theme dir. 404 if the theme is not
   * installed for this tenant. No worker to stop (themes are static); deleting the row also
   * removes the active selection if this was the active theme.
   */
  async uninstall(tenantId: string, name: string): Promise<void> {
    const removed = await this.repo.deleteByName(tenantId, name);
    if (!removed) {
      throw new NotFoundException(`theme not installed: ${name}`);
    }
    await this.ingest.removeThemeDir(name);
  }

  /**
   * The active theme for the public store surface (name + version + settings + optional wire
   * templates), or null. Tenant-scoped via `findActive(tenantId)` — there is NO cross-tenant read
   * path; templates ride the same row, so they inherit that scoping.
   *
   * The templates are already finite by construction (validated at install: ≤6 entries, each
   * ≤ MANIFEST_MAX_BYTES, aggregate-capped). A FINAL aggregate-size guard is applied here as
   * defence-in-depth against a row mutated out-of-band — if the projected payload exceeds the cap
   * the templates are dropped (the field is omitted, the storefront falls back to the bundled set)
   * rather than served, so the public response stays bounded regardless of DB state.
   */
  async getActive(tenantId: string): Promise<ActiveThemeView | null> {
    const row = await this.repo.findActive(tenantId);
    if (!row) return null;
    const view: ActiveThemeView = {
      name: row.name,
      version: row.version,
      settings: (row.settings as Record<string, unknown>) ?? {},
    };
    const templates = ThemesService.safeTemplates(row.templates);
    if (templates && Object.keys(templates).length > 0) {
      return { ...view, templates };
    }
    return view;
  }

  /**
   * Project the stored `templates` jsonb to a serveable map, applying the aggregate-size guard. A
   * non-object value, or a payload that serializes beyond the aggregate cap, yields `undefined`
   * (the field is omitted). This NEVER throws — a corrupt row degrades to "no wire templates", and
   * the storefront uses the bundled set; the public endpoint never 500s on theme data.
   */
  private static safeTemplates(raw: unknown): ThemeTemplateMap | undefined {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(raw);
    } catch {
      return undefined;
    }
    if (Buffer.byteLength(serialized, 'utf8') > THEME_TEMPLATES_AGGREGATE_MAX_BYTES) {
      return undefined;
    }
    return raw as ThemeTemplateMap;
  }

  /** Project a stored row to the admin view. NEVER leaks the on-disk extraction path. */
  private static toView(row: InstalledTheme): InstalledThemeView {
    const manifest = row.manifest as ThemeManifest;
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      slots: manifest?.slots ?? [],
      settings: (row.settings as Record<string, unknown>) ?? {},
      isActive: row.isActive,
      installedAt: row.installedAt,
    };
  }
}
