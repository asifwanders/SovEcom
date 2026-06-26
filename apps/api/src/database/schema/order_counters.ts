import { pgTable, uuid, bigint, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './_tenants';

/**
 * Per-tenant order-number allocator.
 *
 * One row per tenant; `next_value` is the next `orders.order_number` to hand out.
 * Allocated UNDER the order-creation transaction via `SELECT … FOR UPDATE` (or an
 * atomic `UPDATE … RETURNING`) so concurrent checkouts never mint the same number.
 *
 * Order numbers MAY gap: a rolled-back order does NOT reuse its number —
 * unlike `invoice_counters`, which must be gapless (2.8b). Mirrors `invoice_counters`
 * for symmetry + tenant isolation.
 *
 * PK is `tenant_id`. `tenant_id` references tenants with onDelete CASCADE.
 */
export const orderCounters = pgTable('order_counters', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  nextValue: bigint('next_value', { mode: 'bigint' })
    .notNull()
    .default(sql`1`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type OrderCounter = typeof orderCounters.$inferSelect;
export type NewOrderCounter = typeof orderCounters.$inferInsert;
