import { pgTable, uuid, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * Inbound provider webhook-event idempotency log:
 * "record every processed event by Stripe event ID … if already processed, skip." This is
 * the INBOUND provider log — distinct from the OUTBOUND `webhook_*` tables.
 *
 * The dedup key is `UNIQUE(provider, event_id)`. A provider's event id is globally unique
 * per account (Stripe `evt_…`), so a retried/duplicated webhook collides on insert and the
 * handler short-circuits to a no-op — the replay-protection backstop, enforced at the DB.
 *
 * `tenant_id` is NULLABLE: this is a provider-global inbound log written at signature-verify
 * time, before the event is necessarily attributable to a tenant (an unhandled event type
 * may carry no resolvable tenant). When the event references one of our objects we stamp the
 * tenant from its `metadata.tenantId`. `processed_at` is the durable "handled exactly once"
 * marker (see PaymentEventRepository.claimEvent). `payload` holds a REDACTED summary
 * (`safeEventPayload`: event id/type + object id/status) — NEVER the raw event, which carries
 * the PaymentIntent `client_secret` and customer PII. It MUST NOT be relied on for money
 * decisions (re-read the live row under lock for those). NEVER store secrets here.
 */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => ({
    // The replay-protection backstop: a retried Stripe event collides here (no-op).
    providerEventUq: uniqueIndex('payment_events_provider_event_uq').on(t.provider, t.eventId),
    tenantIdx: index('payment_events_tenant_idx').on(t.tenantId),
    typeIdx: index('payment_events_type_idx').on(t.type),
  }),
);

export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type NewPaymentEvent = typeof paymentEvents.$inferInsert;
