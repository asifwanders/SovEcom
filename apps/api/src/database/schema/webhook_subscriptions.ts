import { pgTable, uuid, text, boolean, timestamp, jsonb, index, unique } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * Outbound webhook subscriptions.
 *
 * `events` is a JSONB array of canonical event names the subscriber wants. `secret` is the HMAC
 * signing key stored as an AeadService (AES-256-GCM) ciphertext — NEVER plaintext, NEVER logged,
 * returned to the operator exactly once at create time. `UNIQUE(id, tenant_id)` backs the
 * `webhook_deliveries` composite FK so a delivery can never reference another tenant's subscription.
 */
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    events: jsonb('events').notNull(),
    secret: text('secret').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idTenantUq: unique('webhook_subscriptions_id_tenant_uq').on(t.id, t.tenantId),
    tenantActiveIdx: index('webhook_subscriptions_tenant_active_idx').on(t.tenantId, t.active),
  }),
);

export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;
export type NewWebhookSubscription = typeof webhookSubscriptions.$inferInsert;
