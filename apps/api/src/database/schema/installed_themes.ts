import { pgTable, uuid, text, timestamp, jsonb, boolean, index, unique } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * Installed themes — the admin-approved registry of themes a tenant has installed
 *. One row per (tenant_id, name). `manifest` is the full,
 * re-verified `sovecom.theme.json`; `settings` is an opaque per-install JSON bag (colors/
 * logo/fonts, defaults to `{}`). `is_active` selects the SINGLE live theme for the tenant —
 * a partial UNIQUE(tenant_id) WHERE is_active enforces at-most-one active theme. Themes are
 * declarative ASSETS — there is NO worker, no granted permissions, no `enabled` toggle
 * (unlike `installed_modules`); activation is the only on/off state.
 *
 * Tenant-scoped: declares `UNIQUE(id, tenant_id)` to anchor any future composite
 * tenant-isolation FK and a tenant index. Mirrors `installed_modules.ts`.
 *
 * NOTE: the partial `UNIQUE(tenant_id) WHERE is_active` index drizzle-kit cannot express via
 * the table builder, so it is hand-written in the generated migration.
 */
export const installedThemes = pgTable(
  'installed_themes',
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
    settings: jsonb('settings').notNull().default('{}'),
    // The VALIDATED wire-delivered page templates: a `Record<PageType,
    // ThemeTemplate>` captured + validated at install (parseTemplate + page-match + caps), or `{}`
    // for a tokens/settings-only theme. Rides this tenant-scoped row, so it inherits tenant
    // isolation with NO new query path. Served (projected) by the public store endpoint.
    templates: jsonb('templates').notNull().default('{}'),
    isActive: boolean('is_active').notNull().default(false),
    installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantNameUq: unique('installed_themes_tenant_name_uq').on(t.tenantId, t.name),
    idTenantUq: unique('installed_themes_id_tenant_uq').on(t.id, t.tenantId),
    tenantIdx: index('installed_themes_tenant_idx').on(t.tenantId),
  }),
);

export type InstalledTheme = typeof installedThemes.$inferSelect;
export type NewInstalledTheme = typeof installedThemes.$inferInsert;
