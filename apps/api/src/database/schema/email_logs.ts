import { pgTable, uuid, text, integer, timestamp, index, foreignKey } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { orders } from './orders';
import { emailTypeEnum, emailStatusEnum } from './_enums';

/**
 * Transactional email send log. NOT in the original doc-23 schema;
 * added to satisfy the "email logs visible in admin UI" exit criterion. One row per send is
 * written with the FINAL outcome after the inline retry loop; a resend writes a fresh row.
 *
 * PRIVACY: the message **body is never stored** (less PII at rest; resend
 * re-renders from `order_id` + `type` + `reference_id`). `recipient` IS PII — its RGPD-erase
 * scrubbing is a logged follow-up. `error` carries the transport error message
 * only (no secrets). `reference_id` is the refund id for `refund_issued` so a resend re-renders
 * the EXACT refund (no cross-refund leak). `order_id` is a nullable COMPOSITE FK
 * `(order_id, tenant_id) -> orders`, onDelete **restrict** (a sent email is an ops record).
 */
export const emailLogs = pgTable(
  'email_logs',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id'),
    /** The domain entity this email is about (e.g. the refund id for `refund_issued`). */
    referenceId: uuid('reference_id'),
    recipient: text('recipient').notNull(),
    type: emailTypeEnum('type').notNull(),
    subject: text('subject').notNull(),
    status: emailStatusEnum('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    providerMessageId: text('provider_message_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orderFk: foreignKey({
      columns: [t.orderId, t.tenantId],
      foreignColumns: [orders.id, orders.tenantId],
      name: 'email_logs_order_fk',
    }).onDelete('restrict'),
    tenantCreatedIdx: index('email_logs_tenant_created_idx').on(t.tenantId, t.createdAt),
    tenantOrderIdx: index('email_logs_tenant_order_idx').on(t.tenantId, t.orderId),
    tenantStatusIdx: index('email_logs_tenant_status_idx').on(t.tenantId, t.status),
  }),
);

export type EmailLog = typeof emailLogs.$inferSelect;
export type NewEmailLog = typeof emailLogs.$inferInsert;
