/**
 * PaymentsService — the store payment-intent orchestrator.
 *
 * `createPaymentIntentForCart` is the cart-based entry. It:
 *   1. Enforces per-IP + per-cart velocity caps (card-testing defence, fail-closed).
 *   2. Loads or creates the order from the cart (idempotent — stock consumed at creation).
 *   3. Short-circuits if the order is already paid (or not payable).
 *   4. Creates/reuses a Stripe Customer for a logged-in customer (guests → one-off).
 *   5. Creates the PaymentIntent for the authoritative server total (never a client amount),
 *      idempotency-keyed on the order id (a retry returns the same intent — no double charge).
 *   6. Upserts the `payments` row (keyed on the provider intent id).
 *
 * The webhook — not this method — is the source of truth for "paid".
 */
import {
  Inject,
  Injectable,
  Logger,
  ConflictException,
  UnprocessableEntityException,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { OrderService, type CreateFromCartActor } from '../orders/orders.service';
import { OrderRepository } from '../orders/order.repository';
import { PaymentRepository } from './payment.repository';
import { StripeService } from './stripe/stripe.service';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { PAYMENT_PROVIDER, type PaymentProvider } from './providers/payment-provider.interface';
import type { Payment } from '../database/schema/payments';
import type { Order } from '../database/schema/orders';

/** The store-facing payment-intent response (no internal columns). */
export interface PaymentIntentResponse {
  orderId: string;
  /**
   * `requires_payment` → confirm with the client secret; `paid` → nothing to pay; `processing` →
   * an async payment (SEPA) is already clearing for this order, so the client must NOT start a new
   * one (prevents a second live charge after the idempotency key expires).
   */
  status: 'requires_payment' | 'paid' | 'processing';
  clientSecret: string | null;
  amount: number;
  currency: string;
}

/** Per-IP cap on payment-intent creation within the window (card-testing velocity). */
const IP_LIMIT = 20;
/** Per-cart cap — a single cart being hammered (retry storm / testing). */
const CART_LIMIT = 10;
const WINDOW_SECONDS = 60;

/** Map a Stripe PaymentIntent status onto our `payment_status` enum. */
export function mapIntentStatus(status: string): Payment['status'] {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
      return 'cancelled';
    case 'processing':
      // Async methods (SEPA): confirmed, funds clearing — order stays pending_payment.
      return 'processing';
    default:
      // requires_payment_method / requires_confirmation / requires_action / …
      return 'pending';
  }
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly orders: OrderService,
    private readonly orderRepo: OrderRepository,
    private readonly payments: PaymentRepository,
    private readonly stripe: StripeService,
    private readonly rateLimit: RateLimitService,
  ) {}

  async createPaymentIntentForCart(
    tenantId: string,
    cartId: string,
    actor: CreateFromCartActor,
    ip: string,
  ): Promise<PaymentIntentResponse> {
    // 1. Velocity caps BEFORE creating any order (don't let card-testing spawn orders/stock).
    await this.enforceVelocity(ip, cartId);

    // 2. Load-or-create the order (idempotent; stock consumed at creation).
    const order = await this.orders.createOrLoadFromCart(tenantId, cartId, actor);

    // 3. Only a `pending_payment` order is payable. Already-paid (or beyond) → nothing to do;
    //    a cancelled order is not payable.
    if (order.status !== 'pending_payment') {
      if (order.status === 'cancelled') {
        throw new ConflictException('This order can no longer be paid');
      }
      // paid / fulfilled / shipped / delivered / completed / refunded / partially_refunded
      return {
        orderId: order.id,
        status: 'paid',
        clientSecret: null,
        amount: order.totalAmount,
        currency: order.currency,
      };
    }

    // 3b. If an async payment (SEPA) is already CLEARING for this order, do NOT mint a second
    // intent. Otherwise a SEPA-processing order — which legitimately lives past the ~24h Stripe
    // idempotency-key lifetime — would get a fresh intent on a retry and could be charged twice
    // (card + SEPA). Tell the client it's processing; it must not re-pay.
    if (await this.orderRepo.hasInFlightPayment(tenantId, order.id)) {
      return {
        orderId: order.id,
        status: 'processing',
        clientSecret: null,
        amount: order.totalAmount,
        currency: order.currency,
      };
    }

    // 4. Reuse/create the Stripe Customer for a logged-in customer (guests → null).
    const customerId = await this.ensureProviderCustomer(tenantId, order);

    // 5. Create the intent for the AUTHORITATIVE order total. Idempotency key = order id, so a
    //    retried request returns the SAME intent — never a second charge.
    const intent = await this.provider.createPaymentIntent({
      amount: order.totalAmount,
      currency: order.currency,
      customerId,
      metadata: { orderId: order.id, tenantId },
      idempotencyKey: order.id,
    });

    // 6. Upsert the payment row (idempotent on provider intent id).
    await this.payments.upsertByProviderPaymentId({
      tenantId,
      orderId: order.id,
      provider: this.provider.name,
      providerPaymentId: intent.id,
      method: 'card',
      amount: order.totalAmount,
      currency: order.currency,
      status: mapIntentStatus(intent.status),
    });

    return {
      orderId: order.id,
      status: 'requires_payment',
      clientSecret: intent.clientSecret,
      amount: order.totalAmount,
      currency: order.currency,
    };
  }

  /**
   * Record a MANUAL/offline payment — bank transfer, COD, cash — and drive the order
   * to `paid`. Used by the admin manual-payment endpoint + the mark-paid alias.
   *
   * Order of operations: drive `→ paid` FIRST (under the order row lock, `expectedFrom`-guarded —
   * 409 if the order isn't awaiting payment, so a concurrent/duplicate pay can't double-apply),
   * THEN write the `payments` row. The transition is the money/fiscal effect (it issues the
   * invoice); the manual row is the audit of HOW it was paid. `amount` defaults to the order total.
   *
   * @throws NotFoundException (404) if the order is missing in this tenant.
   * @throws UnprocessableEntityException (422) if a supplied amount ≠ the order total.
   * @throws ConflictException (409) if the order is not `pending_payment` / has an in-flight payment.
   */
  async recordManualPayment(
    tenantId: string,
    orderId: string,
    input: { method: string; amount?: number; actorUserId: string | null },
  ): Promise<{
    orderId: string;
    status: 'paid';
    method: string;
    amount: number;
    currency: string;
  }> {
    // Validate the amount against the IMMUTABLE order total BEFORE changing any state. v1 has no
    // partial-payment model — a manual record pays the order IN FULL; the total is already a valid
    // int4, so requiring equality also forecloses an overflow that would orphan the payment row.
    // Doing this pre-transition means a bad amount never pays the order.
    const existing = await this.orderRepo.findById(tenantId, orderId);
    if (!existing) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    if (input.amount !== undefined && input.amount !== existing.totalAmount) {
      throw new UnprocessableEntityException(
        'Manual payment amount must equal the order total (partial payments are unsupported)',
      );
    }

    const order = await this.orders.transition(tenantId, orderId, 'paid', {
      changedBy: input.actorUserId,
      note: `Manual payment recorded (${input.method})`,
      expectedFrom: 'pending_payment',
      // Don't let an admin mark a clearing SEPA (or already-succeeded) order "paid" — that would
      // double-collect when the SEPA later succeeds. Atomic under the lock.
      precondition: async (tx) => {
        if (await this.orderRepo.hasInFlightPayment(tenantId, orderId, tx)) {
          throw new ConflictException('Order already has an in-flight payment');
        }
      },
    });
    const amount = order.totalAmount;
    try {
      await this.payments.insert({
        tenantId,
        orderId,
        provider: 'manual',
        providerPaymentId: null,
        method: input.method,
        amount,
        currency: order.currency,
        status: 'succeeded',
      });
    } catch (err) {
      // The order is already paid + invoiced (the fiscal effect). A failed audit-row write is
      // surfaced LOUDLY for manual reconciliation, not rolled back (we cannot un-pay the order).
      this.logger.error(
        `Order ${orderId} marked paid (manual) but the payments row failed to persist`,
        err,
      );
    }
    return { orderId, status: 'paid', method: input.method, amount, currency: order.currency };
  }

  /**
   * Per-IP + per-cart velocity caps. Fail-closed (RateLimitService blocks on a
   * Redis outage). A 429 carries NO detail that helps an attacker tune card-testing.
   */
  private async enforceVelocity(ip: string, cartId: string): Promise<void> {
    const [byIp, byCart] = await Promise.all([
      this.rateLimit.check(`pi:ip:${ip}`, { limit: IP_LIMIT, windowSeconds: WINDOW_SECONDS }),
      this.rateLimit.check(`pi:cart:${cartId}`, {
        limit: CART_LIMIT,
        windowSeconds: WINDOW_SECONDS,
      }),
    ]);
    if (!byIp.allowed || !byCart.allowed) {
      // Opaque message — no enumerable detail.
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * Create or reuse the provider Customer for the order's logged-in customer.
   * Returns null for a guest order or a non-Stripe provider. First-writer-wins persistence +
   * a Stripe idempotency key keep concurrent requests from minting duplicate customers.
   */
  private async ensureProviderCustomer(tenantId: string, order: Order): Promise<string | null> {
    if (!order.customerId || this.provider.name !== 'stripe') {
      return null;
    }
    const customer = await this.payments.getCustomerForStripe(tenantId, order.customerId);
    if (!customer) {
      // Defensive: the order references a customer that vanished — fall back to a guest intent.
      this.logger.warn(`Order ${order.id} references missing customer; using guest intent`);
      return null;
    }
    if (customer.stripeCustomerId) {
      return customer.stripeCustomerId;
    }
    const stripeCustomerId = await this.stripe.ensureCustomer({
      email: customer.email,
      name: customer.name,
      metadata: { tenantId, customerId: order.customerId },
      idempotencyKey: `cust:${tenantId}:${order.customerId}`,
    });
    await this.payments.setStripeCustomerId(tenantId, order.customerId, stripeCustomerId);
    // Re-read so that, if a concurrent request won the first-writer-wins UPDATE, we return the
    // id that is actually stored (Stripe's idempotency key makes both ids identical anyway).
    const reread = await this.payments.getCustomerForStripe(tenantId, order.customerId);
    return reread?.stripeCustomerId ?? stripeCustomerId;
  }
}
