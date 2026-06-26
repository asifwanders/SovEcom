import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  check,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { orders } from './orders';
import { payments } from './payments';
import { users } from './users';
import { refundStatusEnum } from './_enums';

/**
 * Refunds against a payment. A refund that reduces a fiscal total drives a
 * credit-note issuance — that linkage is a future addition.
 *
 * Three COMPOSITE FKs: `(order_id, tenant_id)` and `(payment_id, tenant_id)` both onDelete
 * **RESTRICT** (financial records); `(created_by, tenant_id) -> users` nullable, onDelete
 * RESTRICT. UNIQUE on `provider_refund_id` (partial, where not null). Money: integer minor
 * units; `currency` char_length=3. Parent of `refund_line_items` and referenced by
 * `returns.refund_id`, so it declares `UNIQUE(id, tenant_id)`.
 */
export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    providerRefundId: text('provider_refund_id'),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    taxAmount: integer('tax_amount').notNull().default(0),
    reason: text('reason'),
    restocked: boolean('restocked').notNull().default(false),
    status: refundStatusEnum('status').notNull().default('pending'),
    /**
     * for an ASYNC (e.g. SEPA) refund recorded `pending`, the IRREVERSIBLE/fiscal
     * side-effects (credit-note issuance, restock, order→refunded drive) are DEFERRED until the
     * confirming `refund.updated` succeeded event — because an issued credit note is a gapless,
     * immutable fiscal document that cannot be cleanly voided if the bank later rejects the
     * refund. This stashes the precomputed payload so confirmation is a pure replay; it is
     * CLEARED to null once the effects are applied (succeeded) or backed out (failed). Null for
     * synchronous (immediately-`succeeded`) refunds, which apply everything inline as before.
     */
    deferredPayload: jsonb('deferred_payload'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderFk: foreignKey({
      columns: [t.orderId, t.tenantId],
      foreignColumns: [orders.id, orders.tenantId],
      name: 'refunds_order_fk',
    }).onDelete('restrict'),
    paymentFk: foreignKey({
      columns: [t.paymentId, t.tenantId],
      foreignColumns: [payments.id, payments.tenantId],
      name: 'refunds_payment_fk',
    }).onDelete('restrict'),
    createdByFk: foreignKey({
      columns: [t.createdBy, t.tenantId],
      foreignColumns: [users.id, users.tenantId],
      name: 'refunds_created_by_fk',
    }).onDelete('restrict'),
    idTenantUq: unique('refunds_id_tenant_uq').on(t.id, t.tenantId),
    providerRefundUq: uniqueIndex('refunds_provider_refund_uq')
      .on(t.providerRefundId)
      .where(sql`provider_refund_id is not null`),
    orderIdx: index('refunds_order_idx').on(t.orderId),
    paymentIdx: index('refunds_payment_idx').on(t.paymentId),
    // Index the created_by FK (TR-DATA-008) — supports the users-RESTRICT lookup.
    createdByIdx: index('refunds_created_by_idx').on(t.createdBy),
    tenantIdx: index('refunds_tenant_idx').on(t.tenantId),
    amountChk: check('refunds_amount_chk', sql`${t.amount} >= 0`),
    taxAmountChk: check('refunds_tax_amount_chk', sql`${t.taxAmount} >= 0`),
    currencyChk: check('refunds_currency_chk', sql`char_length(${t.currency}) = 3`),
  }),
);

export type Refund = typeof refunds.$inferSelect;
export type NewRefund = typeof refunds.$inferInsert;
