/**
 * ModulesRepository.
 *
 * Tenant-scoped access to `installed_modules`. EVERY query filters on `tenant_id`, so a
 * tenant can never read, install over, or delete another tenant's module. The `(tenant_id,
 * name)` UNIQUE constraint is the persistence-layer enforcement of "one install per module"
 * — `insert` surfaces that conflict as a typed
 * {@link ModuleAlreadyInstalledError} so the service maps it to a 409 (and cleans the
 * extracted dir) rather than leaking a raw SQLSTATE.
 *
 * Mirrors `shipping.repository.ts`.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { DatabaseService } from '../database/database.service';
import {
  installedModules,
  type InstalledModule,
  type NewInstalledModule,
} from '../database/schema/installed_modules';
import type { ModuleManifest } from './module-manifest';

/** The fields the service hands the repo for an install. */
export interface InstallModuleInput {
  readonly tenantId: string;
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly manifest: ModuleManifest;
  readonly grantedPermissions: string[];
}

/**
 * Raised when an install collides with the `(tenant_id, name)` UNIQUE constraint — i.e. the
 * module is already installed for this tenant. The service maps this to a 409.
 */
export class ModuleAlreadyInstalledError extends Error {
  constructor(public readonly moduleName: string) {
    super(`module already installed: ${moduleName}`);
    this.name = 'ModuleAlreadyInstalledError';
  }
}

@Injectable()
export class ModulesRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Insert a new installed-module row. On a `(tenant_id, name)` unique violation throws
   * {@link ModuleAlreadyInstalledError}. Returns the stored row.
   */
  async insert(input: InstallModuleInput): Promise<InstalledModule> {
    const values: NewInstalledModule = {
      id: uuidv7(),
      tenantId: input.tenantId,
      name: input.name,
      version: input.version,
      source: input.source,
      manifest: input.manifest,
      grantedPermissions: input.grantedPermissions,
      settings: {},
      enabled: true,
    };
    try {
      const [row] = await this.db.insert(installedModules).values(values).returning();
      return row!;
    } catch (err) {
      if (ModulesRepository.isUniqueViolation(err)) {
        throw new ModuleAlreadyInstalledError(input.name);
      }
      throw err;
    }
  }

  /** The installed module named `name` in this tenant, or null. Tenant-scoped. */
  async findByName(tenantId: string, name: string): Promise<InstalledModule | null> {
    const [row] = await this.db
      .select()
      .from(installedModules)
      .where(and(eq(installedModules.tenantId, tenantId), eq(installedModules.name, name)))
      .limit(1);
    return row ?? null;
  }

  /** All modules installed for this tenant (name-ordered). Tenant-scoped. */
  list(tenantId: string): Promise<InstalledModule[]> {
    return this.db
      .select()
      .from(installedModules)
      .where(eq(installedModules.tenantId, tenantId))
      .orderBy(installedModules.name);
  }

  /** Delete the named module IN THIS TENANT. Returns true iff a row was removed. */
  async deleteByName(tenantId: string, name: string): Promise<boolean> {
    const rows = await this.db
      .delete(installedModules)
      .where(and(eq(installedModules.tenantId, tenantId), eq(installedModules.name, name)))
      .returning({ id: installedModules.id });
    return rows.length > 0;
  }

  /**
   * Set the `enabled` flag for a module. Returns `true` if a matching row was found and updated
   * (whether or not the value changed), `false` if the module is not installed for this tenant.
   * Used by `ModuleRuntimeService.enable` / `.disable` to persist the administrative intent.
   */
  async setEnabled(tenantId: string, name: string, enabled: boolean): Promise<boolean> {
    const rows = await this.db
      .update(installedModules)
      .set({ enabled, updatedAt: sql`now()` })
      .where(and(eq(installedModules.tenantId, tenantId), eq(installedModules.name, name)))
      .returning({ id: installedModules.id });
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
