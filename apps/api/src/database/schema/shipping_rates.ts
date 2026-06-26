import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  index,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { shippingZones } from './shipping_zones';
import { shippingRateTypeEnum } from './_enums';

/**
 * Shipping rates within a zone (one row per weight band, with
 * `weight_min_grams`/`weight_max_grams` columns; NOT a JSONB weightBands array).
 *
 * `zone_id` is a COMPOSITE FK `(zone_id, tenant_id) -> shipping_zones` onDelete **CASCADE**
 * (a rate is an owned child of its zone). Money: `amount` + nullable `free_over_amount`
 * are integer minor units; `currency` TEXT + char_length=3 CHECK.
 */
export const shippingRates = pgTable(
  'shipping_rates',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    zoneId: uuid('zone_id').notNull(),
    name: text('name').notNull(),
    type: shippingRateTypeEnum('type').notNull(),
    amount: integer('amount').notNull().default(0),
    currency: text('currency').notNull(),
    freeOverAmount: integer('free_over_amount'),
    weightMinGrams: integer('weight_min_grams'),
    weightMaxGrams: integer('weight_max_grams'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    zoneFk: foreignKey({
      columns: [t.zoneId, t.tenantId],
      foreignColumns: [shippingZones.id, shippingZones.tenantId],
      name: 'shipping_rates_zone_fk',
    }).onDelete('cascade'),
    zoneIdx: index('shipping_rates_zone_idx').on(t.zoneId),
    tenantIdx: index('shipping_rates_tenant_idx').on(t.tenantId),
    amountChk: check('shipping_rates_amount_chk', sql`${t.amount} >= 0`),
    currencyChk: check('shipping_rates_currency_chk', sql`char_length(${t.currency}) = 3`),
  }),
);

export type ShippingRate = typeof shippingRates.$inferSelect;
export type NewShippingRate = typeof shippingRates.$inferInsert;
