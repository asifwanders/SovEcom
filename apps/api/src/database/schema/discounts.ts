import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { discountTypeEnum, discountScopeEnum } from './_enums';

/**
 * Discount definitions (v1 has only `percentage`/`fixed`;
 * free-shipping is a shipping-rate override, stacking is the `stackable` boolean).
 *
 * `value` is integer (percent ×100, or fixed minor units). `currency` is nullable
 * (only meaningful for fixed) — when present, a char_length=3 CHECK applies. UNIQUE
 * `(tenant_id, code)` partial (where code not null) so automatic discounts (null code)
 * don't collide. Parent of `discount_usages`, so it declares `UNIQUE(id, tenant_id)`.
 */
export const discounts = pgTable(
  'discounts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    code: text('code'),
    /** Admin display label. `default('')` makes the NOT NULL
     *  column add deploy-safe on any DB with pre-existing rows; new rows always get a
     *  real name (the create DTO requires min length 1). */
    name: text('name').notNull().default(''),
    type: discountTypeEnum('type').notNull(),
    value: integer('value').notNull(),
    currency: text('currency'),
    minCartAmount: integer('min_cart_amount'),
    appliesTo: discountScopeEnum('applies_to').notNull().default('all'),
    targetIds: jsonb('target_ids'),
    customerSegment: text('customer_segment'),
    stackable: boolean('stackable').notNull().default(false),
    usageLimitTotal: integer('usage_limit_total'),
    usageLimitPerCustomer: integer('usage_limit_per_customer'),
    usedCount: integer('used_count').notNull().default(0),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idTenantUq: unique('discounts_id_tenant_uq').on(t.id, t.tenantId),
    codeUq: uniqueIndex('discounts_tenant_code_uq')
      .on(t.tenantId, t.code)
      .where(sql`code is not null`),
    tenantActiveIdx: index('discounts_tenant_active_idx').on(t.tenantId, t.active),
    currencyChk: check(
      'discounts_currency_chk',
      sql`${t.currency} is null or char_length(${t.currency}) = 3`,
    ),
    // Non-negative discount value (percent ×100 or fixed minor units — never negative).
    valueChk: check('discounts_value_nonneg_chk', sql`${t.value} >= 0`),
  }),
);

export type Discount = typeof discounts.$inferSelect;
export type NewDiscount = typeof discounts.$inferInsert;
