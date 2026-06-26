import { pgTable, uuid, text, numeric, timestamp, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * VAT / tax rates keyed by `(country, region)` (a single
 * `tax_rates` table; "zones" are a query concept over `country`, not a table).
 *
 * `rate` is NUMERIC(5,4) (0.2000 = 20%). `country` is CHAR(2) (ISO 3166-1) modelled as
 * TEXT + char_length=2 CHECK (text+CHECK, never char(2) — see product_variants). UNIQUE
 * `(tenant_id, country, region)` — `region` NULL distinguishes the country-wide default,
 * so the unique index uses COALESCE so two NULL-region rows for the same country collide.
 */
export const taxRates = pgTable(
  'tax_rates',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    country: text('country').notNull(),
    region: text('region'),
    rate: numeric('rate', { precision: 5, scale: 4 }).notNull(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    countryRegionUq: uniqueIndex('tax_rates_tenant_country_region_uq').on(
      t.tenantId,
      t.country,
      sql`coalesce(${t.region}, '')`,
    ),
    countryChk: check('tax_rates_country_chk', sql`char_length(${t.country}) = 2`),
  }),
);

export type TaxRate = typeof taxRates.$inferSelect;
export type NewTaxRate = typeof taxRates.$inferInsert;
