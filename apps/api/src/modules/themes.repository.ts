/**
 * ThemesRepository.
 *
 * Tenant-scoped access to `installed_themes`. Every query filters on `tenant_id`, so a tenant
 * can never read, install over, activate, or delete another tenant's theme. The `(tenant_id,
 * name)` UNIQUE constraint enforces "one install per theme" — `insert` surfaces that conflict as
 * {@link ThemeAlreadyInstalledError} so the service maps it to a 409. The partial
 * `UNIQUE(tenant_id) WHERE is_active` enforces a single active theme; `activate` clears every
 * other theme's `is_active` BEFORE setting the target's in one transaction so the constraint
 * is never transiently violated.
 *
 * Mirrors `modules.repository.ts` + `addresses.repository.ts` (the one-default-per-X tx pattern).
 */
import { Injectable } from '@nestjs/common';
import { and, eq, ne, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '../database/database.service';
import {
  installedThemes,
  type InstalledTheme,
  type NewInstalledTheme,
} from '../database/schema/installed_themes';
import type { ThemeManifest } from './theme-manifest';
import type { ThemeTemplateMap } from './theme-ingest.service';

/** The fields the service hands the repo for an install. */
export interface InstallThemeInput {
  readonly tenantId: string;
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly manifest: ThemeManifest;
  /**
   * The validated wire-delivered templates captured at install, or `{}` for a
   * tokens-only theme. Persisted into the tenant-scoped row's `templates` JSONB column.
   */
  readonly templates: ThemeTemplateMap;
}

/**
 * Raised when an install collides with the `(tenant_id, name)` UNIQUE constraint — i.e. the
 * theme is already installed for this tenant. The service maps this to a 409 (no silent overwrite).
 */
export class ThemeAlreadyInstalledError extends Error {
  constructor(public readonly themeName: string) {
    super(`theme already installed: ${themeName}`);
    this.name = 'ThemeAlreadyInstalledError';
  }
}

@Injectable()
export class ThemesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Insert a new installed-theme row (always `is_active=false` — a fresh install never auto-
   * activates). On a `(tenant_id, name)` unique violation throws {@link ThemeAlreadyInstalledError}
   * (never an UPDATE). Returns the stored row.
   */
  async insert(input: InstallThemeInput): Promise<InstalledTheme> {
    const values: NewInstalledTheme = {
      id: uuidv7(),
      tenantId: input.tenantId,
      name: input.name,
      version: input.version,
      source: input.source,
      manifest: input.manifest,
      settings: {},
      // Validated-at-install templates (or `{}`); jsonb. Tenant-scoped via this row.
      templates: input.templates,
      isActive: false,
    };
    try {
      const [row] = await this.db.insert(installedThemes).values(values).returning();
      return row!;
    } catch (err) {
      if (ThemesRepository.isUniqueViolation(err)) {
        throw new ThemeAlreadyInstalledError(input.name);
      }
      throw err;
    }
  }

  /** The installed theme named `name` in this tenant, or null. Tenant-scoped. */
  async findByName(tenantId: string, name: string): Promise<InstalledTheme | null> {
    const [row] = await this.db
      .select()
      .from(installedThemes)
      .where(and(eq(installedThemes.tenantId, tenantId), eq(installedThemes.name, name)))
      .limit(1);
    return row ?? null;
  }

  /** All themes installed for this tenant (name-ordered). Tenant-scoped. */
  list(tenantId: string): Promise<InstalledTheme[]> {
    return this.db
      .select()
      .from(installedThemes)
      .where(eq(installedThemes.tenantId, tenantId))
      .orderBy(installedThemes.name);
  }

  /** The single active theme for this tenant, or null. Tenant-scoped. */
  async findActive(tenantId: string): Promise<InstalledTheme | null> {
    const [row] = await this.db
      .select()
      .from(installedThemes)
      .where(and(eq(installedThemes.tenantId, tenantId), eq(installedThemes.isActive, true)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Activate the named theme: deactivate every OTHER theme for the tenant, then set the named
   * one active — in ONE transaction so the partial `UNIQUE(tenant_id) WHERE is_active` is never
   * transiently violated (the constraint is checked per-statement, so we MUST clear the old
   * active before setting the new one). Returns the activated row, or null if the theme is not
   * installed for this tenant.
   */
  async activate(tenantId: string, name: string): Promise<InstalledTheme | null> {
    return this.db.transaction(async (tx) => {
      // 0. SELECT the target FIRST. If the theme is not installed for this tenant, bail BEFORE the
      //    deactivate UPDATE — otherwise step 1 would unset the live active theme and commit, leaving
      //    the storefront with NO active theme while the service still 404s (mirrors the
      //    SELECT-first-then-bail pattern in addresses.repository.ts update()).
      const [existing] = await tx
        .select({ id: installedThemes.id })
        .from(installedThemes)
        .where(and(eq(installedThemes.tenantId, tenantId), eq(installedThemes.name, name)))
        .limit(1);
      if (!existing) {
        return null;
      }
      // 1. Clear every other theme's active flag for this tenant (the one being activated is
      //    excluded so an already-active re-activate is a no-op rather than a flap).
      await tx
        .update(installedThemes)
        .set({ isActive: false, updatedAt: sql`now()` })
        .where(
          and(
            eq(installedThemes.tenantId, tenantId),
            ne(installedThemes.name, name),
            eq(installedThemes.isActive, true),
          ),
        );
      // 2. Set the named theme active. The update is scoped to (tenant, name).
      const rows = await tx
        .update(installedThemes)
        .set({ isActive: true, updatedAt: sql`now()` })
        .where(and(eq(installedThemes.tenantId, tenantId), eq(installedThemes.name, name)))
        .returning();
      return rows[0] ?? null;
    });
  }

  /**
   * Replace the `settings` JSON bag for the named theme. Returns the updated row, or null when
   * the theme is not installed for this tenant. (Replace, not merge — the admin PATCH supplies
   * the full settings object; merge semantics are a later refinement once a settings schema is
   * validated.)
   */
  async setSettings(
    tenantId: string,
    name: string,
    settings: Record<string, unknown>,
  ): Promise<InstalledTheme | null> {
    const rows = await this.db
      .update(installedThemes)
      .set({ settings, updatedAt: sql`now()` })
      .where(and(eq(installedThemes.tenantId, tenantId), eq(installedThemes.name, name)))
      .returning();
    return rows[0] ?? null;
  }

  /** Delete the named theme IN THIS TENANT. Returns true iff a row was removed. */
  async deleteByName(tenantId: string, name: string): Promise<boolean> {
    const rows = await this.db
      .delete(installedThemes)
      .where(and(eq(installedThemes.tenantId, tenantId), eq(installedThemes.name, name)))
      .returning({ id: installedThemes.id });
    return rows.length > 0;
  }

  /**
   * Postgres unique_violation (SQLSTATE 23505) — the `(tenant,name)` collision. Drizzle wraps
   * driver errors in a `DrizzleQueryError` whose original `postgres` error (carrying `.code`)
   * is on `.cause`, so we check both the error itself AND its cause chain.
   */
  private static isUniqueViolation(err: unknown): boolean {
    const hasCode23505 = (e: unknown): boolean =>
      typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
    if (hasCode23505(err)) return true;
    const cause = (err as { cause?: unknown })?.cause;
    return hasCode23505(cause);
  }
}
