import { pgTable, uuid, text, timestamp, jsonb, boolean, index, unique } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * Installed modules — the admin-approved registry of modules a tenant has installed.
 * One row per (tenant_id, name). `manifest` is the full, re-verified `sovecom.module.json`;
 * `granted_permissions` is the admin-approved subset of the manifest's requested permissions
 * (default-deny). `settings` is an opaque per-install JSON bag (defaults to `{}`). `enabled`
 * toggles the module without deleting its data.
 *
 * Tenant-scoped: declares `UNIQUE(id, tenant_id)` to anchor any future composite
 * tenant-isolation FK and a tenant index. Mirrors `shipping_zones.ts`.
 */
export const installedModules = pgTable(
  'installed_modules',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: text('version').notNull(),
    source: text('source').notNull(),
    manifest: jsonb('manifest').notNull(),
    grantedPermissions: jsonb('granted_permissions').notNull(),
    settings: jsonb('settings').notNull().default('{}'),
    enabled: boolean('enabled').notNull().default(true),
    installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantNameUq: unique('installed_modules_tenant_name_uq').on(t.tenantId, t.name),
    idTenantUq: unique('installed_modules_id_tenant_uq').on(t.id, t.tenantId),
    tenantIdx: index('installed_modules_tenant_idx').on(t.tenantId),
  }),
);

export type InstalledModule = typeof installedModules.$inferSelect;
export type NewInstalledModule = typeof installedModules.$inferInsert;
