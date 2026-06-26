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
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { orders } from './orders';
import { invoiceTypeEnum } from './_enums';

/**
 * Legal fiscal documents. Immutable once issued; no
 * UPDATE/DELETE of issued rows — corrections are issued as a separate `credit_note`.
 *
 * `invoice_number` is **gapless** per `(tenant, series)` — allocated from
 * `invoice_counters` under a row lock at issuance (allocation logic is deferred). The UNIQUE `(tenant_id, series, invoice_number)`
 * enforces no duplicate within a series.
 *
 * `order_id` is a COMPOSITE FK with onDelete **RESTRICT** — an order with an issued
 * invoice can never be deleted (fiscal retention). `corrects_invoice_id` is a nullable
 * self-referential COMPOSITE FK `(corrects_invoice_id, tenant_id) -> invoices`
 * (credit-note → original) with onDelete **RESTRICT**. Parent (self-ref target), so it
 * declares `UNIQUE(id, tenant_id)`. Money: integer minor units; `currency` char_length=3.
 *
 * Immutability: a DB trigger (migration 0010) rejects DELETE and
 * UPDATE of fiscal columns on an issued invoice (app-layer immutability first; the trigger
 * is the belt-and-braces backstop), permitting only a one-time `storage_key` NULL→value set.
 */
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    type: invoiceTypeEnum('type').notNull().default('invoice'),
    series: text('series').notNull(),
    invoiceNumber: text('invoice_number').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    sellerSnapshot: jsonb('seller_snapshot').notNull(),
    buyerSnapshot: jsonb('buyer_snapshot').notNull(),
    currency: text('currency').notNull(),
    subtotalAmount: integer('subtotal_amount').notNull(),
    taxBreakdown: jsonb('tax_breakdown').notNull(),
    taxAmount: integer('tax_amount').notNull(),
    totalAmount: integer('total_amount').notNull(),
    reverseCharge: boolean('reverse_charge').notNull().default(false),
    viesConsultationRef: text('vies_consultation_ref'),
    correctsInvoiceId: uuid('corrects_invoice_id'),
    storageKey: text('storage_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderFk: foreignKey({
      columns: [t.orderId, t.tenantId],
      foreignColumns: [orders.id, orders.tenantId],
      name: 'invoices_order_fk',
    }).onDelete('restrict'),
    correctsFk: foreignKey({
      columns: [t.correctsInvoiceId, t.tenantId],
      foreignColumns: [t.id, t.tenantId],
      name: 'invoices_corrects_fk',
    }).onDelete('restrict'),
    idTenantUq: unique('invoices_id_tenant_uq').on(t.id, t.tenantId),
    numberUq: uniqueIndex('invoices_tenant_series_number_uq').on(
      t.tenantId,
      t.series,
      t.invoiceNumber,
    ),
    orderIdx: index('invoices_order_idx').on(t.orderId),
    // Index the self-ref FK (TR-DATA-008) — credit-note → original lookups.
    correctsIdx: index('invoices_corrects_idx').on(t.correctsInvoiceId),
    tenantIssuedIdx: index('invoices_tenant_issued_idx').on(t.tenantId, t.issuedAt),
    currencyChk: check('invoices_currency_chk', sql`char_length(${t.currency}) = 3`),
    // Non-negative money: a credit note is a SEPARATE `credit_note` document (its own
    // gapless series, `corrects_invoice_id` → original) carrying POSITIVE amounts — it is
    // never a negated mutation of the original invoice. So all invoice
    // money columns are >= 0 for both `invoice` and `credit_note` types.
    amountsChk: check(
      'invoices_amounts_nonneg_chk',
      sql`${t.subtotalAmount} >= 0 and ${t.taxAmount} >= 0 and ${t.totalAmount} >= 0`,
    ),
  }),
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
