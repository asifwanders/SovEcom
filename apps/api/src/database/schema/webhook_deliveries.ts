import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { webhookSubscriptions } from './webhook_subscriptions';
import { deliveryStatusEnum } from './_enums';

/**
 * Outbound webhook deliveries. This table IS the durable
 * delivery queue (transactional outbox): one row per (event × matching subscription), inserted
 * `pending` at fan-out time, leased + processed by the @Cron worker via the `(status,
 * next_retry_at)` index. A non-2xx/error sets `failed` + a backed-off `next_retry_at`; the schedule
 * running out sets `exhausted`. `last_error` holds a short transport/status string only — NEVER the
 * secret or signature. Composite FK `(subscription_id, tenant_id) → webhook_subscriptions`,
 * onDelete CASCADE (a deleted subscription drops its delivery log).
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id').notNull(),
    event: text('event').notNull(),
    payload: jsonb('payload').notNull(),
    status: deliveryStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }).defaultNow().notNull(),
    responseCode: integer('response_code'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    subscriptionFk: foreignKey({
      columns: [t.subscriptionId, t.tenantId],
      foreignColumns: [webhookSubscriptions.id, webhookSubscriptions.tenantId],
      name: 'webhook_deliveries_subscription_fk',
    }).onDelete('cascade'),
    dueIdx: index('webhook_deliveries_due_idx').on(t.status, t.nextRetryAt),
    tenantSubCreatedIdx: index('webhook_deliveries_tenant_sub_created_idx').on(
      t.tenantId,
      t.subscriptionId,
      t.createdAt,
    ),
  }),
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type NewWebhookDelivery = typeof webhookDeliveries.$inferInsert;
