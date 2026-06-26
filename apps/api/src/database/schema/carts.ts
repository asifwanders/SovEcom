import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { customers } from './customers';
import { cartStatusEnum } from './_enums';

/**
 * Shopping carts.
 *
 * `customer_id` is nullable (null = guest cart, tracked by `session_token`). It is a
 * COMPOSITE FK `(customer_id, tenant_id) -> customers(id, tenant_id)` so a
 * cart can never straddle tenants; a guest cart (NULL customer_id) is exempt from the FK
 * by Postgres MATCH SIMPLE semantics. Money: `currency` TEXT NOT NULL with a
 * `char_length = 3` CHECK (text+CHECK, never char(3)). Parent of
 * `cart_items` and `inventory_reservations`, so it declares `UNIQUE(id, tenant_id)`.
 *
 * onDelete: customer CASCADE (deleting a customer takes their carts); tenant CASCADE.
 */
export const carts = pgTable(
  'carts',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id'),
    sessionToken: text('session_token'),
    currency: text('currency').notNull(),
    discountCode: text('discount_code'),
    status: cartStatusEnum('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    customerFk: foreignKey({
      columns: [t.customerId, t.tenantId],
      foreignColumns: [customers.id, customers.tenantId],
      name: 'carts_customer_fk',
    }).onDelete('cascade'),
    idTenantUq: unique('carts_id_tenant_uq').on(t.id, t.tenantId),
    tenantIdx: index('carts_tenant_idx').on(t.tenantId),
    customerIdx: index('carts_customer_idx').on(t.customerId),
    sessionTokenIdx: index('carts_session_token_idx').on(t.sessionToken),
    activeExpiresIdx: index('carts_active_expires_idx')
      .on(t.expiresAt)
      .where(sql`status = 'active'`),
    // At most ONE active cart per (tenant, customer). A partial
    // unique index over the active, customer-owned rows stops two concurrent
    // associates from minting duplicate active carts for the same customer. Guest
    // carts (customer_id IS NULL) are exempt — the predicate excludes them.
    oneActivePerCustomerUq: uniqueIndex('carts_one_active_per_customer')
      .on(t.tenantId, t.customerId)
      .where(sql`status = 'active' AND customer_id IS NOT NULL`),
    currencyChk: check('carts_currency_chk', sql`char_length(${t.currency}) = 3`),
  }),
);

export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;
