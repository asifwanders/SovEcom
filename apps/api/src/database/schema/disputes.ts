import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
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
import { payments } from './payments';
import { disputeStatusEnum } from './_enums';

/**
 * Disputes / chargebacks against a payment. A dispute is not just
 * a flag: `charge.dispute.created` freezes fulfillment on the order (`orders.fulfillment_frozen`)
 * and records the evidence deadline; `*.updated`/`*.closed` update this row. A LOST dispute's
 * money reconciliation is handled through the refund/credit-note path.
 *
 * Two COMPOSITE FKs — `(order_id, tenant_id)` and `(payment_id, tenant_id)`, both onDelete
 * **RESTRICT** (a financial/legal record must not vanish with its order/payment). UNIQUE on
 * `provider_dispute_id` (partial, where not null) gives webhook idempotency for the dispute
 * object. `status` is the coarse workflow enum; `provider_status` keeps Stripe's verbatim
 * status. Money: integer minor units; `currency` char_length=3.
 */
export const disputes = pgTable(
  'disputes',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    provider: text('provider').notNull(),
    providerDisputeId: text('provider_dispute_id'),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    reason: text('reason'),
    status: disputeStatusEnum('status').notNull().default('open'),
    providerStatus: text('provider_status'),
    evidenceDueBy: timestamp('evidence_due_by', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderFk: foreignKey({
      columns: [t.orderId, t.tenantId],
      foreignColumns: [orders.id, orders.tenantId],
      name: 'disputes_order_fk',
    }).onDelete('restrict'),
    paymentFk: foreignKey({
      columns: [t.paymentId, t.tenantId],
      foreignColumns: [payments.id, payments.tenantId],
      name: 'disputes_payment_fk',
    }).onDelete('restrict'),
    idTenantUq: unique('disputes_id_tenant_uq').on(t.id, t.tenantId),
    providerDisputeUq: uniqueIndex('disputes_provider_dispute_uq')
      .on(t.providerDisputeId)
      .where(sql`provider_dispute_id is not null`),
    orderIdx: index('disputes_order_idx').on(t.orderId),
    paymentIdx: index('disputes_payment_idx').on(t.paymentId),
    tenantIdx: index('disputes_tenant_idx').on(t.tenantId),
    amountChk: check('disputes_amount_chk', sql`${t.amount} >= 0`),
    currencyChk: check('disputes_currency_chk', sql`char_length(${t.currency}) = 3`),
  }),
);

export type Dispute = typeof disputes.$inferSelect;
export type NewDispute = typeof disputes.$inferInsert;
