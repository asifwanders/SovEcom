import { pgTable, uuid, jsonb, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * Storefront home sections — the singleton marketing-section list for a tenant's home page.
 *
 * One row per tenant (`UNIQUE(tenant_id)` enforces at-most-one record). `sections` is a JSONB
 * array of `{ type, settings }` descriptors validated by `parseMarketingSection` from
 * `@sovecom/theme-sdk` on every write; the API rejects the entire request if ANY entry fails
 * validation (fail-closed — no partial saves). On read the service re-validates each stored
 * entry and silently drops any corrupt row (defence-in-depth; never throws on read).
 *
 * Tenant-scoped: declares `UNIQUE(id, tenant_id)` to anchor any future composite
 * tenant-isolation FK and a tenant index. Mirrors `installed_themes.ts`.
 */
export const storefrontHomeSections = pgTable(
  'storefront_home_sections',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Validated marketing section descriptors. Array of `{ type, settings }`. */
    sections: jsonb('sections').notNull().default('[]'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantUq: unique('storefront_home_sections_tenant_uq').on(t.tenantId),
    idTenantUq: unique('storefront_home_sections_id_tenant_uq').on(t.id, t.tenantId),
    tenantIdx: index('storefront_home_sections_tenant_idx').on(t.tenantId),
  }),
);

export type StorefrontHomeSection = typeof storefrontHomeSections.$inferSelect;
export type NewStorefrontHomeSection = typeof storefrontHomeSections.$inferInsert;
