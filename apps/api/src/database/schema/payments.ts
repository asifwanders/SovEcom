import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { orders } from './orders';
import { paymentStatusEnum } from './_enums';

/**
 * Payment attempts/records against an order.
 *
 * `order_id` is a COMPOSITE FK with onDelete **RESTRICT** — a financial record must not
 * vanish with its order. UNIQUE `(provider, provider_payment_id)` gives webhook
 * idempotency (modelled as a partial unique index where `provider_payment_id` is not
 * null, so multiple pending rows without a provider id are allowed). Money: integer minor
 * units; `currency` char_length=3. Parent of `refunds`, so it declares
 * `UNIQUE(id, tenant_id)`.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    provider: text('provider').notNull(),
    providerPaymentId: text('provider_payment_id'),
    method: text('method'),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    status: paymentStatusEnum('status').notNull().default('pending'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderFk: foreignKey({
      columns: [t.orderId, t.tenantId],
      foreignColumns: [orders.id, orders.tenantId],
      name: 'payments_order_fk',
    }).onDelete('restrict'),
    idTenantUq: unique('payments_id_tenant_uq').on(t.id, t.tenantId),
    providerPaymentUq: uniqueIndex('payments_provider_payment_uq')
      .on(t.provider, t.providerPaymentId)
      .where(sql`provider_payment_id is not null`),
    orderIdx: index('payments_order_idx').on(t.orderId),
    tenantIdx: index('payments_tenant_idx').on(t.tenantId),
    amountChk: check('payments_amount_chk', sql`${t.amount} >= 0`),
    currencyChk: check('payments_currency_chk', sql`char_length(${t.currency}) = 3`),
  }),
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
