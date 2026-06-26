import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { orders } from './orders';
import { customers } from './customers';
import { users } from './users';
import { refunds } from './refunds';
import { returnTypeEnum, returnStatusEnum } from './_enums';

/**
 * Return / 14-day statutory withdrawal requests.
 *
 * `items` is a JSONB list of `{ order_item_id, qty }`. Four COMPOSITE FKs, all onDelete
 * **RESTRICT** (a return request references legal/financial records that must not
 * disappear underneath it): `(order_id, tenant_id) -> orders`,
 * `(customer_id, tenant_id) -> customers` (nullable), `(resolved_by, tenant_id) -> users`
 * (nullable), `(refund_id, tenant_id) -> refunds` (nullable). `within_withdrawal_window`
 * captures the statutory 14-day flag at request time.
 */
export const returns = pgTable(
  'returns',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id'),
    type: returnTypeEnum('type').notNull(),
    status: returnStatusEnum('status').notNull().default('requested'),
    items: jsonb('items').notNull(),
    reason: text('reason'),
    withinWithdrawalWindow: boolean('within_withdrawal_window').notNull().default(false),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by'),
    refundId: uuid('refund_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderFk: foreignKey({
      columns: [t.orderId, t.tenantId],
      foreignColumns: [orders.id, orders.tenantId],
      name: 'returns_order_fk',
    }).onDelete('restrict'),
    customerFk: foreignKey({
      columns: [t.customerId, t.tenantId],
      foreignColumns: [customers.id, customers.tenantId],
      name: 'returns_customer_fk',
    }).onDelete('restrict'),
    resolvedByFk: foreignKey({
      columns: [t.resolvedBy, t.tenantId],
      foreignColumns: [users.id, users.tenantId],
      name: 'returns_resolved_by_fk',
    }).onDelete('restrict'),
    refundFk: foreignKey({
      columns: [t.refundId, t.tenantId],
      foreignColumns: [refunds.id, refunds.tenantId],
      name: 'returns_refund_fk',
    }).onDelete('restrict'),
    tenantStatusIdx: index('returns_tenant_status_idx').on(t.tenantId, t.status),
    orderIdx: index('returns_order_idx').on(t.orderId),
    customerIdx: index('returns_customer_idx').on(t.customerId),
    // Index the resolved_by + refund FKs (TR-DATA-008) — support the RESTRICT lookups.
    resolvedByIdx: index('returns_resolved_by_idx').on(t.resolvedBy),
    refundIdx: index('returns_refund_idx').on(t.refundId),
  }),
);

export type Return = typeof returns.$inferSelect;
export type NewReturn = typeof returns.$inferInsert;
