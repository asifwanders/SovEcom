/**
 * PaymentWebhookService: the inbound Stripe webhook brain.
 *
 * The webhook is the SOURCE OF TRUTH for "paid" (never the client). Flow:
 *   1. verify the signature (StripeService.constructWebhookEvent → 400 on bad/missing/unsigned);
 *   2. claim the event by id (payment_events UNIQUE) — a duplicate/replayed event no-ops;
 *   3. dispatch to an IDEMPOTENT handler; on failure release the claim so Stripe's retry
 *      reprocesses (handlers are idempotent, so reprocessing never double-applies).
 *
 * Webhooks arrive with NO ordering guarantee, so every handler reads current state (under the
 * order lock, via OrderService.transition) before acting. Card/PAN data never appears here.
 */
import { Injectable, Logger } from '@nestjs/common';
import { StripeService } from './stripe/stripe.service';
import { PaymentEventRepository } from './payment-event.repository';
import { PaymentRepository } from './payment.repository';
import { DisputeRepository } from './dispute.repository';
import { OrderService } from '../orders/orders.service';
import { OrderRepository } from '../orders/order.repository';
import { RefundService } from './refunds/refund.service';
import { DatabaseService } from '../database/database.service';
import type { StripeEvent } from './stripe/stripe.types';
import type { Dispute } from '../database/schema/disputes';

const PROVIDER = 'stripe';

/** The minimal PaymentIntent fields we consume (we read only what we need, not the full type). */
interface PiShape {
  id: string;
  status: string;
  amount?: number;
  currency?: string;
  metadata?: Record<string, string> | null;
}

/** The minimal Charge fields we consume from `charge.refunded`. */
interface ChargeShape {
  id: string;
  payment_intent?: string | null;
  refunds?: { data?: { id: string; amount: number; status: string }[] } | null;
}

/** The minimal Refund fields we consume from `refund.created` / `refund.updated`. */
interface RefundShape {
  id: string;
  payment_intent?: string | null;
  amount: number;
  status: string;
}

/** The minimal Charge.Dispute fields we consume. */
interface DisputeShape {
  id: string;
  amount: number;
  currency: string;
  reason?: string | null;
  status: string;
  payment_intent?: string | null;
  evidence_details?: { due_by?: number | null } | null;
}

/** Map a Stripe dispute status onto our coarse workflow enum. */
export function mapDisputeStatus(status: string): Dispute['status'] {
  if (status === 'won') return 'won';
  if (status === 'lost') return 'lost';
  return 'open';
}

/**
 * Build the REDACTED payload persisted in `payment_events`. The raw Stripe event carries secrets
 * (PaymentIntent `client_secret`) AND customer PII (email/name/address on charges) — storing it
 * verbatim breaks the table's "NEVER store secrets" contract and the EU-privacy rules. We keep
 * only non-sensitive identifiers sufficient to debug "which event, which object, what state":
 * event id/type + the object's id/status. No secrets, no PII.
 */
export function safeEventPayload(event: StripeEvent): Record<string, unknown> {
  const obj = event.data?.object as { id?: string; status?: string } | undefined;
  return {
    id: event.id,
    type: event.type,
    objectId: obj?.id ?? null,
    objectStatus: obj?.status ?? null,
  };
}

@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly events: PaymentEventRepository,
    private readonly payments: PaymentRepository,
    private readonly disputes: DisputeRepository,
    private readonly orders: OrderService,
    private readonly orderRepo: OrderRepository,
    private readonly refundService: RefundService,
    private readonly db: DatabaseService,
  ) {}

  /**
   * Verify, dedupe, and dispatch one inbound webhook. Throws (→ 400) on a bad signature; on a
   * handler failure releases the claim and rethrows (→ 500) so Stripe retries.
   */
  async processWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    // 1. VERIFY first — an unsigned/forged body never gets past here.
    const event = this.stripe.constructWebhookEvent(rawBody ?? Buffer.alloc(0), signature);

    // 2. Claim by event id (processed-aware replay protection). Best-effort tenant from metadata.
    // The persisted payload is REDACTED (no client_secret / PII) — see safeEventPayload.
    const tenantId = this.tenantFromEvent(event);
    const claim = await this.events.claimEvent({
      provider: PROVIDER,
      eventId: event.id,
      type: event.type,
      tenantId,
      payload: safeEventPayload(event),
    });
    if (claim === 'done') {
      this.logger.debug(`Duplicate webhook ${event.id} (${event.type}) — already processed`);
      return;
    }

    // 3. Dispatch idempotently, then mark processed (the durable exactly-once marker). On failure
    // the claim stays `processed_at = NULL` and we rethrow → Stripe retries → reprocessed (a
    // killed worker between claim-commit and here is recovered, not lost).
    try {
      await this.dispatch(event);
      await this.events.markProcessed(PROVIDER, event.id);
    } catch (err) {
      this.logger.error(`Webhook ${event.id} (${event.type}) failed; left for retry`, err);
      throw err;
    }
  }

  private async dispatch(event: StripeEvent): Promise<void> {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.onPaymentSucceeded(event.data.object as unknown as PiShape);
        break;
      case 'payment_intent.processing':
        await this.onPaymentProcessing(event.data.object as unknown as PiShape);
        break;
      case 'payment_intent.payment_failed':
        await this.onPaymentFailed(event.data.object as unknown as PiShape);
        break;
      case 'charge.dispute.created':
        await this.onDispute(event.data.object as unknown as DisputeShape, true);
        break;
      case 'charge.dispute.updated':
      case 'charge.dispute.closed':
        await this.onDispute(event.data.object as unknown as DisputeShape, false);
        break;
      // `refund.created`/`refund.updated` carry the Refund object directly — the PRIMARY refund
      // path (modern Stripe API omits `charge.refunds.data` from `charge.refunded`). `updated`
      // also confirms a pending SEPA refund → succeeded.
      case 'refund.created':
      case 'refund.updated':
        await this.onRefund(event.data.object as unknown as RefundShape);
        break;
      case 'charge.refunded':
        // Fallback (older API versions that DO embed the refunds list). Idempotent vs the above.
        await this.onChargeRefunded(event.data.object as unknown as ChargeShape);
        break;
      default:
        this.logger.debug(`Unhandled webhook type ${event.type} (${event.id}) — recorded only`);
    }
  }

  /** `payment_intent.succeeded` → mark payment succeeded → drive order → paid (idempotent). */
  private async onPaymentSucceeded(pi: PiShape): Promise<void> {
    const ids = this.resolveOrderRef(pi);
    if (!ids) {
      this.logger.warn(`payment_intent.succeeded ${pi.id} has no resolvable order — ignored`);
      return;
    }
    const { tenantId, orderId } = ids;

    const order = await this.orderRepo.findById(tenantId, orderId);
    if (!order) {
      this.logger.error(`payment_intent.succeeded ${pi.id} → order ${orderId} not found`);
      return;
    }

    // Self-healing upsert: record the payment as succeeded even if the intent-endpoint's row
    // write lost a race with this webhook. Amount/currency from the ORDER (authoritative).
    await this.payments.upsertByProviderPaymentId({
      tenantId,
      orderId,
      provider: PROVIDER,
      providerPaymentId: pi.id,
      method: 'card',
      amount: order.totalAmount,
      currency: order.currency,
      status: 'succeeded',
    });

    if (order.status === 'pending_payment') {
      await this.orders.transition(tenantId, orderId, 'paid', {
        note: 'Stripe payment confirmed (webhook)',
      });
      this.logger.log(`Order ${orderId} marked paid via Stripe webhook`);
    } else if (order.status === 'cancelled') {
      // Paid-after-cancel race (sweeper cancelled before the payment landed). Funds captured
      // but the order is dead — needs a manual refund. Surface LOUDLY for reconciliation.
      this.logger.error(
        `PAYMENT CAPTURED FOR CANCELLED ORDER ${orderId} (pi=${pi.id}) — manual refund required`,
      );
    } else if (await this.payments.hasSucceededPaymentExcept(tenantId, orderId, pi.id)) {
      // Order already paid by a DIFFERENT intent — a SECOND collection landed.
      // The intent endpoint's in-flight guard makes this rare, but surface it LOUDLY if it happens.
      this.logger.error(
        `DOUBLE COLLECTION on order ${orderId}: succeeded pi=${pi.id} but it was already paid by another intent — verify + refund`,
      );
    }
    // else: same-intent replay on an already-finalised order — nothing to do.
  }

  /**
   * `payment_intent.processing` → an ASYNC method (SEPA) was accepted but funds have NOT cleared
   *. Record the payment as `processing`; the order stays `pending_payment` (NO
   * transition — we never fulfil before money is in). This row is also what shields the order
   * from the stale-unpaid sweeper. `→ paid` happens later on `succeeded`.
   */
  private async onPaymentProcessing(pi: PiShape): Promise<void> {
    const ids = this.resolveOrderRef(pi);
    if (!ids) {
      this.logger.warn(`payment_intent.processing ${pi.id} has no resolvable order — ignored`);
      return;
    }
    const { tenantId, orderId } = ids;
    const order = await this.orderRepo.findById(tenantId, orderId);
    if (!order) {
      this.logger.error(`payment_intent.processing ${pi.id} → order ${orderId} not found`);
      return;
    }
    // Only act while the order is still awaiting payment. A late/out-of-order `processing` event
    // after the order is already paid (or cancelled) is stale — applying it would regress a
    // `succeeded` payment row back to `processing`. Skip it.
    if (order.status !== 'pending_payment') {
      this.logger.warn(
        `Stale payment_intent.processing ${pi.id} for ${order.status} order ${orderId} — skipped`,
      );
      return;
    }
    await this.payments.upsertByProviderPaymentId({
      tenantId,
      orderId,
      provider: PROVIDER,
      providerPaymentId: pi.id,
      method: 'sepa_debit',
      amount: order.totalAmount,
      currency: order.currency,
      status: 'processing',
    });
    this.logger.log(
      `Payment ${pi.id} (order ${orderId}) processing (async clearing) — awaiting funds`,
    );
  }

  /** `payment_intent.payment_failed` → mark the payment failed; order stays payable (retry). */
  private async onPaymentFailed(pi: PiShape): Promise<void> {
    const payment = await this.payments.findByProviderPaymentId(PROVIDER, pi.id);
    if (!payment) {
      this.logger.warn(`payment_intent.payment_failed ${pi.id} has no payment row — ignored`);
      return;
    }
    await this.payments.updateStatus(payment.tenantId, payment.id, 'failed');
    this.logger.log(
      `Payment ${payment.id} (order ${payment.orderId}) marked failed; retry allowed`,
    );
  }

  /** `refund.created` / `refund.updated` → reconcile the single Refund. */
  private async onRefund(refund: RefundShape): Promise<void> {
    if (!refund.payment_intent) {
      this.logger.warn(`refund ${refund.id} has no payment_intent — ignored`);
      return;
    }
    const payment = await this.payments.findByProviderPaymentId(PROVIDER, refund.payment_intent);
    if (!payment) {
      this.logger.warn(`refund ${refund.id} → payment ${refund.payment_intent} not found`);
      return;
    }
    await this.refundService.reconcileGatewayRefund(
      payment.tenantId,
      payment.orderId,
      refund.id,
      refund.amount,
      refund.status,
    );
  }

  /**
   * `charge.refunded` → reconcile EACH refund on the charge. Idempotent on
   * `provider_refund_id`: an admin-initiated refund's echoing webhook is a no-op; a
   * dashboard-initiated refund is recorded (refund + credit note + order state).
   */
  private async onChargeRefunded(charge: ChargeShape): Promise<void> {
    if (!charge.payment_intent) {
      this.logger.warn(`charge.refunded ${charge.id} has no payment_intent — ignored`);
      return;
    }
    const payment = await this.payments.findByProviderPaymentId(PROVIDER, charge.payment_intent);
    if (!payment) {
      this.logger.warn(`charge.refunded ${charge.id} → payment ${charge.payment_intent} not found`);
      return;
    }
    const refunds = charge.refunds?.data ?? [];
    for (const r of refunds) {
      if (r.status !== 'succeeded') continue;
      await this.refundService.reconcileGatewayRefund(
        payment.tenantId,
        payment.orderId,
        r.id,
        r.amount,
        r.status,
      );
    }
  }

  /** `charge.dispute.*` → record the dispute; on creation freeze the order's fulfillment. */
  private async onDispute(d: DisputeShape, freeze: boolean): Promise<void> {
    if (!d.payment_intent) {
      this.logger.warn(`dispute ${d.id} has no payment_intent — cannot link; ignored`);
      return;
    }
    const payment = await this.payments.findByProviderPaymentId(PROVIDER, d.payment_intent);
    if (!payment) {
      this.logger.warn(`dispute ${d.id} → payment intent ${d.payment_intent} not found; ignored`);
      return;
    }

    const incoming = mapDisputeStatus(d.status);

    // Serialise the WHOLE read→decide→freeze sequence in ONE transaction under the order row lock.
    // Without it, two distinct event ids (a redelivered `created` with a fresh id, or two
    // `charge.dispute.*` events) can both read `existing=null` and both freeze — re-freezing an
    // order an admin may have just unfrozen (a read-then-act TOCTOU). The FOR UPDATE lock makes
    // concurrent deliveries queue: the second sees the first's committed dispute row → no re-freeze.
    await this.db.db.transaction(async (tx) => {
      // 1. Lock the order — the serialisation point. (If it's missing/soft-deleted we still record
      //    the dispute below; there is simply nothing to freeze.)
      await this.orderRepo.findByIdForUpdate(tx, payment.tenantId, payment.orderId);

      // 2. READ current state under the lock, then guard against out-of-order / redelivered events:
      //    won/lost are TERMINAL. A redelivered `created` (or any stale event) arriving after the
      //    dispute already resolved must NOT regress the status back to open and must NOT (re)freeze
      //    an order an admin may have already unfrozen. Idempotency-log dedup only catches identical
      //    event ids; Stripe can still redeliver an OLDER event id.
      const existing = await this.disputes.findByProviderDisputeId(payment.tenantId, d.id, tx);
      const isTerminal = existing?.status === 'won' || existing?.status === 'lost';
      if (isTerminal && incoming !== existing!.status) {
        this.logger.warn(
          `Stale charge.dispute.* (${d.status}) for already-${existing!.status} dispute ${d.id} — ` +
            `status NOT regressed, order NOT re-frozen`,
        );
        return;
      }

      await this.disputes.upsertByProviderDisputeId(
        {
          tenantId: payment.tenantId,
          orderId: payment.orderId,
          paymentId: payment.id,
          provider: PROVIDER,
          providerDisputeId: d.id,
          amount: d.amount,
          currency: d.currency.toUpperCase(),
          reason: d.reason ?? null,
          status: incoming,
          providerStatus: d.status,
          evidenceDueBy: d.evidence_details?.due_by
            ? new Date(d.evidence_details.due_by * 1000)
            : null,
        },
        tx,
      );

      // 3. Only freeze on a genuine, FIRST `created` (no prior dispute row). A redelivered `created`
      //    for a dispute already recorded (even still-open) must not re-freeze an order the admin
      //    unfroze while the dispute is being worked. The read above ran under the same lock, so a
      //    concurrent delivery cannot also observe `existing=null` and double-freeze.
      if (freeze && !existing) {
        await this.orderRepo.setFulfillmentFrozen(payment.tenantId, payment.orderId, true, tx);
        this.logger.warn(
          `Dispute ${d.id} opened on order ${payment.orderId} — fulfillment FROZEN (admin action needed)`,
        );
      }
    });
  }

  /**
   * Resolve {tenantId, orderId} for a PaymentIntent: trust the SIGNED event metadata we stamped
   * at creation (the signature proves it is Stripe echoing our own data).
   */
  private resolveOrderRef(pi: PiShape): { tenantId: string; orderId: string } | null {
    const tenantId = pi.metadata?.tenantId;
    const orderId = pi.metadata?.orderId;
    if (tenantId && orderId) return { tenantId, orderId };
    return null;
  }

  /** Best-effort tenant id for the event log (PaymentIntent metadata; null otherwise). */
  private tenantFromEvent(event: StripeEvent): string | null {
    const obj = event.data.object as unknown as { metadata?: Record<string, string> | null };
    return obj?.metadata?.tenantId ?? null;
  }
}
