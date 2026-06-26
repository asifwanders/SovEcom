/**
 * SlotsRepository.
 *
 * Tenant-scoped reads for the slot registry: the ENABLED modules (name + manifest, the only
 * fields the registry needs — never the granted-permissions blob) and the admin's slot
 * resolutions. EVERY query filters on `tenant_id`, so one tenant's modules/resolutions are
 * invisible to another. Writes go through `upsertResolution` (the composite PK
 * `(tenant_id, slot)` makes the upsert at-most-one-per-slot).
 *
 * The registry NEVER mutates state during a read — `upsertResolution` is the only write, driven
 * by the admin `PUT /admin/v1/slots/:slot/resolution`. A stale resolution (naming a module that
 * no longer targets the slot) is left in place and simply ignored by the service (re-conflict).
 */
import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { installedModules } from '../database/schema/installed_modules';
import {
  moduleSlotResolutions,
  type ModuleSlotResolution,
} from '../database/schema/module_slot_resolutions';
import type { ModuleManifest } from './module-manifest';

/** An enabled module as the registry sees it (name + its parsed manifest). */
export interface EnabledModuleRow {
  readonly name: string;
  readonly manifest: ModuleManifest;
}

@Injectable()
export class SlotsRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** The tenant's ENABLED modules (name + manifest only). Tenant-scoped. */
  async listEnabledModules(tenantId: string): Promise<EnabledModuleRow[]> {
    const rows = await this.db
      .select({ name: installedModules.name, manifest: installedModules.manifest })
      .from(installedModules)
      .where(and(eq(installedModules.tenantId, tenantId), eq(installedModules.enabled, true)))
      .orderBy(installedModules.name);
    return rows.map((r) => ({ name: r.name, manifest: r.manifest as ModuleManifest }));
  }

  /** Every slot resolution for the tenant. Tenant-scoped. */
  listResolutions(tenantId: string): Promise<ModuleSlotResolution[]> {
    return this.db
      .select()
      .from(moduleSlotResolutions)
      .where(eq(moduleSlotResolutions.tenantId, tenantId));
  }

  /**
   * Insert or replace the admin's chosen winner for `(tenant, slot)`. The composite PK makes
   * this at-most-one-per-slot; a re-resolution overwrites the previous pick and bumps
   * `updated_at`. Tenant-scoped (the PK includes `tenant_id`).
   */
  async upsertResolution(tenantId: string, slot: string, moduleName: string): Promise<void> {
    await this.db
      .insert(moduleSlotResolutions)
      .values({ tenantId, slot, moduleName })
      .onConflictDoUpdate({
        target: [moduleSlotResolutions.tenantId, moduleSlotResolutions.slot],
        set: { moduleName, updatedAt: sql`now()` },
      });
  }
}
