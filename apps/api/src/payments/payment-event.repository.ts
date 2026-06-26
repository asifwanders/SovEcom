/**
 * PaymentEventRepository: the inbound webhook idempotency log.
 *
 * `claimEvent` is PROCESSED-AWARE (Fable B1 fix): the dedup decision keys on whether the event
 * was actually *handled to completion* (`processed_at`), not merely whether a claim row exists.
 *   - `'new'`        — first sight → process it;
 *   - `'unprocessed'`— claim row exists but `processed_at IS NULL` → a prior attempt died (crash
 *                      between claim-commit and dispatch, or a still-in-flight concurrent
 *                      delivery) → REPROCESS (handlers are idempotent; the order FOR UPDATE lock
 *                      serialises concurrent ones, the second seeing already-paid → no-op);
 *   - `'done'`       — `processed_at` set → a true duplicate/replay → skip.
 * This closes the lost-payment gap where a killed worker left a committed claim that a Stripe
 * retry would otherwise dedupe to a no-op, stranding a captured payment in `pending_payment`.
 */
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { paymentEvents, type NewPaymentEvent } from '../database/schema/payment_events';

/** Outcome of a claim attempt — see class docs. */
export type ClaimResult = 'new' | 'unprocessed' | 'done';

@Injectable()
export class PaymentEventRepository {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Claim an event by `(provider, event_id)`. Inserts on first sight; on conflict, returns
   * whether the existing claim was already processed. Only `'done'` short-circuits the handler.
   */
  async claimEvent(values: NewPaymentEvent): Promise<ClaimResult> {
    const inserted = await this.db
      .insert(paymentEvents)
      .values(values)
      .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.eventId] })
      .returning({ id: paymentEvents.id });
    if (inserted.length > 0) return 'new';

    const [existing] = await this.db
      .select({ processedAt: paymentEvents.processedAt })
      .from(paymentEvents)
      .where(
        and(eq(paymentEvents.provider, values.provider), eq(paymentEvents.eventId, values.eventId)),
      )
      .limit(1);
    return existing?.processedAt ? 'done' : 'unprocessed';
  }

  /** Mark a claimed event processed — the durable "handled exactly once" marker. */
  async markProcessed(provider: string, eventId: string): Promise<void> {
    await this.db
      .update(paymentEvents)
      .set({ processedAt: new Date() })
      .where(and(eq(paymentEvents.provider, provider), eq(paymentEvents.eventId, eventId)));
  }
}
