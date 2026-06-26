import { pgTable, uuid, text, timestamp, index, foreignKey } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { orders } from './orders';
import { users } from './users';
import { orderStatusEnum } from './_enums';

/**
 * Append-only order status transition log.
 *
 * `order_id` is a COMPOSITE FK with ON DELETE CASCADE. `changed_by` is a nullable
 * COMPOSITE FK `(changed_by, tenant_id) -> users(id, tenant_id)` (null = system action);
 * its onDelete is **RESTRICT** — a user who changed an order's status cannot be
 * hard-deleted, preserving the audit trail (users only disappear via tenant cascade,
 * which clears this row through its own tenant_id CASCADE FK first).
 */
export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    fromStatus: orderStatusEnum('from_status'),
    toStatus: orderStatusEnum('to_status').notNull(),
    changedBy: uuid('changed_by'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderFk: foreignKey({
      columns: [t.orderId, t.tenantId],
      foreignColumns: [orders.id, orders.tenantId],
      name: 'order_status_history_order_fk',
    }).onDelete('cascade'),
    changedByFk: foreignKey({
      columns: [t.changedBy, t.tenantId],
      foreignColumns: [users.id, users.tenantId],
      name: 'order_status_history_changed_by_fk',
    }).onDelete('restrict'),
    orderCreatedIdx: index('order_status_history_order_created_idx').on(t.orderId, t.createdAt),
    // Index the changed_by FK (TR-DATA-008) — supports the users-RESTRICT lookup.
    changedByIdx: index('order_status_history_changed_by_idx').on(t.changedBy),
    tenantIdx: index('order_status_history_tenant_idx').on(t.tenantId),
  }),
);

export type OrderStatusHistory = typeof orderStatusHistory.$inferSelect;
export type NewOrderStatusHistory = typeof orderStatusHistory.$inferInsert;
