import { pgTable, uuid, integer, index, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { refunds } from './refunds';
import { orderItems } from './order_items';

/**
 * Per-line breakdown of a partial refund.
 *
 * Note: the column list includes `tenant_id` for composite-FK tenant-isolation
 * convention requires it for the FKs below. `tenant_id` is therefore ADDED here (flagged
 * in the build report). It carries a tenants CASCADE FK like every other table.
 *
 * Two COMPOSITE FKs: `(refund_id, tenant_id) -> refunds` onDelete **CASCADE** (an owned
 * child of the refund); `(order_item_id, tenant_id) -> order_items` onDelete **RESTRICT**
 * (the financial linkage to the order line must not vanish underneath it).
 */
export const refundLineItems = pgTable(
  'refund_line_items',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    refundId: uuid('refund_id').notNull(),
    orderItemId: uuid('order_item_id').notNull(),
    quantity: integer('quantity').notNull(),
    amount: integer('amount').notNull(),
  },
  (t) => ({
    refundFk: foreignKey({
      columns: [t.refundId, t.tenantId],
      foreignColumns: [refunds.id, refunds.tenantId],
      name: 'refund_line_items_refund_fk',
    }).onDelete('cascade'),
    orderItemFk: foreignKey({
      columns: [t.orderItemId, t.tenantId],
      foreignColumns: [orderItems.id, orderItems.tenantId],
      name: 'refund_line_items_order_item_fk',
    }).onDelete('restrict'),
    refundIdx: index('refund_line_items_refund_idx').on(t.refundId),
    // Index the order_item FK (TR-DATA-008) — supports the order_items-RESTRICT lookup.
    orderItemIdx: index('refund_line_items_order_item_idx').on(t.orderItemId),
    tenantIdx: index('refund_line_items_tenant_idx').on(t.tenantId),
    quantityChk: check('refund_line_items_quantity_chk', sql`${t.quantity} > 0`),
    amountChk: check('refund_line_items_amount_chk', sql`${t.amount} >= 0`),
  }),
);

export type RefundLineItem = typeof refundLineItems.$inferSelect;
export type NewRefundLineItem = typeof refundLineItems.$inferInsert;
