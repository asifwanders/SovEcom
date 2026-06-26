import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/**
 * Tenants — the root of the multi-tenancy model. v1 ships single-tenant (exactly
 * one row), but every core table carries a `tenant_id` FK to this table so the
 * Phase-4 Agency Control Plane does not require a schema refactor.
 *
 * IDs are UUID v7 (time-sortable) per the DB conventions, generated app-side via
 * the `uuidv7` package (PostgreSQL 17 has no native `uuidv7()`; that arrives in PG 18).
 */
export const tenants = pgTable('tenants', {
  id: uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /**
   * Per-tenant settings. Home of `tax_mode`
   * (`none` | `eu_vat`), `prices_include_tax` (bool), `oss_posture`
   * (`below_threshold` | `above_or_opted_in`), and the EU-VAT registration
   * (`{ originCountry, vatNumber }`). Read/written through TenantSettingsService.
   * Defaults to `{}` — a fresh store resolves to `tax_mode='none'`,
   * `prices_include_tax=true` via the service's typed defaults.
   */
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
