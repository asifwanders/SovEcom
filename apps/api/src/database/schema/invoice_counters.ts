import { pgTable, uuid, text, bigint, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './_tenants';

/**
 * Gapless invoice-number allocator. One row per
 * `(tenant_id, series)`; `next_value` is the next number to hand out.
 *
 * 2.1 builds ONLY the table. The gapless allocation-under-row-lock logic
 * (`SELECT … FOR UPDATE`, increment, write the invoice in one transaction — NOT a bare
 * Postgres sequence, which gaps on rollback) is deferred.
 *
 * PK `(tenant_id, series)`. `tenant_id` references tenants with onDelete CASCADE.
 */
export const invoiceCounters = pgTable(
  'invoice_counters',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    series: text('series').notNull(),
    nextValue: bigint('next_value', { mode: 'bigint' })
      .notNull()
      .default(sql`1`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.series], name: 'invoice_counters_pk' }),
  }),
);

export type InvoiceCounter = typeof invoiceCounters.$inferSelect;
export type NewInvoiceCounter = typeof invoiceCounters.$inferInsert;
