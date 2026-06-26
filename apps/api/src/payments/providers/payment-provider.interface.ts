/**
 * The payment-provider abstraction.
 *
 * `PaymentsService` depends on this interface, never on Stripe directly, allowing for future
 * payment providers (SEPA/manual adapters, Mollie, etc.) without touching the order/payment flow.
 * Stripe is the primary provider; manual payments are supported.
 *
 * Money is ALWAYS integer minor units + an ISO-4217 currency code. The provider NEVER sees raw
 * card data (SAQ-A — the PAN is collected by the hosted Element in the browser).
 */

/** DI token for the active {@link PaymentProvider} (bound to Stripe). */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface CreatePaymentIntentParams {
  /** Integer minor units — the AUTHORITATIVE server-computed order total. Never client-supplied. */
  amount: number;
  /** ISO-4217 currency code (3 chars). */
  currency: string;
  /** The provider customer id to attach (Stripe `cus_…`), or null for a guest one-off intent. */
  customerId?: string | null;
  /** Opaque key→value map echoed back on the webhook (we put `orderId` + `tenantId` here). */
  metadata: Record<string, string>;
  /**
   * Provider idempotency key — a retried create with the SAME key returns the SAME intent and
   * never creates a second charge. We use the order id (one live intent per order).
   */
  idempotencyKey: string;
}

export interface PaymentIntentResult {
  /** The provider payment-intent id (Stripe `pi_…`) — stored as `payments.provider_payment_id`. */
  id: string;
  /** The client secret the browser Element confirms with. May be null for offline methods. */
  clientSecret: string | null;
  /** The provider's intent status string (e.g. `requires_payment_method`, `succeeded`). */
  status: string;
}

/** Refund params. */
export interface CreateRefundParams {
  /** The provider payment-intent id to refund against. */
  paymentIntentId: string;
  /** Integer minor units to refund (≤ captured). */
  amount: number;
  currency: string;
  idempotencyKey: string;
  reason?: string;
}

export interface RefundResult {
  id: string;
  status: string;
}

/** A swappable payment provider. Implementations: Stripe (live), Manual, and others. */
export interface PaymentProvider {
  /** Stable provider key persisted on `payments.provider` (e.g. `stripe`). */
  readonly name: string;
  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult>;
  createRefund(params: CreateRefundParams): Promise<RefundResult>;
}
