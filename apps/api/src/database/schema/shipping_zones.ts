import { pgTable, uuid, text, timestamp, jsonb, index, unique } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * Shipping zones — a named group of countries. `countries` is a JSONB
 * array of ISO 3166-1 codes. Parent of `shipping_rates`, so it declares
 * `UNIQUE(id, tenant_id)` to anchor the composite tenant-isolation FK.
 */
export const shippingZones = pgTable(
  'shipping_zones',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    countries: jsonb('countries').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idTenantUq: unique('shipping_zones_id_tenant_uq').on(t.id, t.tenantId),
    tenantIdx: index('shipping_zones_tenant_idx').on(t.tenantId),
  }),
);

export type ShippingZone = typeof shippingZones.$inferSelect;
export type NewShippingZone = typeof shippingZones.$inferInsert;
