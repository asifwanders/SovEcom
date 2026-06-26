import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import { STRIPE_CLIENT } from './stripe.client';
import type { StripeClient, StripeEvent, StripeRefundReason } from './stripe.types';
import type {
  CreatePaymentIntentParams,
  PaymentIntentResult,
  CreateRefundParams,
  RefundResult,
} from '../providers/payment-provider.interface';

/** Params for creating/reusing a Stripe Customer. */
export interface EnsureCustomerParams {
  email: string;
  name?: string | null;
  /** Stamped on the Stripe Customer so the dashboard links back to our customer. */
  metadata: Record<string, string>;
  /** Idempotency key (we use `cust:<tenantId>:<customerId>`) so retries don't duplicate. */
  idempotencyKey: string;
}

/**
 * thin wrapper over the Stripe SDK: the ONLY place that talks to
 * Stripe. Reads the injected {@link STRIPE_CLIENT} (null when unconfigured) + the webhook
 * signing secret from env. Every method that needs the client fails CLOSED with a clear
 * 503 when Stripe is not configured — never a silent no-op on the money path.
 *
 * NEVER logs secrets, client secrets, signatures, or card data (SAQ-A).
 */
@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly webhookSecret: string | undefined;

  constructor(@Inject(STRIPE_CLIENT) private readonly stripe: StripeClient | null) {
    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!this.stripe) {
      this.logger.warn('Stripe disabled — no STRIPE_SECRET_KEY configured; payments will 503');
    }
  }

  /** True when Stripe is configured (secret key present). */
  get isConfigured(): boolean {
    return this.stripe !== null;
  }

  private requireClient(): StripeClient {
    if (!this.stripe) {
      throw new ServiceUnavailableException('Payments are not available');
    }
    return this.stripe;
  }

  /**
   * Create a PaymentIntent for the AUTHORITATIVE server amount. `automatic_payment_methods`
   * lets Stripe surface card + (later) SEPA / Apple Pay / Google Pay from the one Element.
   * The idempotency key (the order id) guarantees a retried create returns the same intent —
   * never a second charge.
   */
  async createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult> {
    const stripe = this.requireClient();
    const intent = await stripe.paymentIntents.create(
      {
        amount: params.amount,
        currency: params.currency.toLowerCase(),
        customer: params.customerId ?? undefined,
        metadata: params.metadata,
        automatic_payment_methods: { enabled: true },
      },
      { idempotencyKey: params.idempotencyKey },
    );
    return { id: intent.id, clientSecret: intent.client_secret, status: intent.status };
  }

  /** Refund against a captured PaymentIntent. */
  async createRefund(params: CreateRefundParams): Promise<RefundResult> {
    const stripe = this.requireClient();
    const refund = await stripe.refunds.create(
      {
        payment_intent: params.paymentIntentId,
        amount: params.amount,
        reason: params.reason as StripeRefundReason,
      },
      { idempotencyKey: params.idempotencyKey },
    );
    return { id: refund.id, status: refund.status ?? 'unknown' };
  }

  /** Create or reuse a Stripe Customer for a logged-in customer. */
  async ensureCustomer(params: EnsureCustomerParams): Promise<string> {
    const stripe = this.requireClient();
    const customer = await stripe.customers.create(
      { email: params.email, name: params.name ?? undefined, metadata: params.metadata },
      { idempotencyKey: params.idempotencyKey },
    );
    return customer.id;
  }

  /**
   * Verify + parse an inbound webhook. Throws a 400 on a missing/invalid signature or an
   * unconfigured secret — an unsigned/forged event is REJECTED, never processed. `payload` MUST
   * be the raw request body (Buffer), not the parsed JSON.
   */
  constructWebhookEvent(payload: Buffer | string, signature: string | undefined): StripeEvent {
    const stripe = this.requireClient();
    if (!this.webhookSecret) {
      // Fail closed: without the signing secret we cannot trust any event.
      throw new ServiceUnavailableException('Webhook verification is not available');
    }
    if (!signature) {
      throw new BadRequestException('Missing webhook signature');
    }
    try {
      return stripe.webhooks.constructEvent(payload, signature, this.webhookSecret);
    } catch {
      // Do NOT leak the verification detail to the caller.
      throw new BadRequestException('Invalid webhook signature');
    }
  }
}
