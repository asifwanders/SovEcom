/**
 * StaleOrderSweeperService — cancels abandoned unpaid orders.
 *
 * Cancels `pending_payment` orders whose payment never completed within a window, releasing the
 * stock they hold (via `order.cancelled` → OrderRestockListener). This is the counterpart to
 * the cart-based flow consuming stock at order creation: an abandoned payment must not pin
 * inventory forever.
 *
 * Race-safe: each candidate is cancelled through `OrderService.transition` with
 * `expectedFrom: 'pending_payment'`, re-checked under the order row lock — so a payment that
 * confirms between the scan and the cancel can never cancel a just-paid order (409, skipped).
 */
import { ConflictException, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrderRepository } from './order.repository';
import { OrderService } from './orders.service';

/** Default minutes a `pending_payment` order may live before the sweep cancels it. */
const DEFAULT_TTL_MINUTES = 60;
/**
 * Hard ceiling on the TTL. The Stripe idempotency key is the order id and expires
 * after ~24h; if an unpaid order outlived that and the cap, a re-`createPaymentIntentForCart`
 * could mint a second live charge. Capping the TTL well under 24h guarantees the order is
 * cancelled long before the key expires.
 */
const MAX_TTL_MINUTES = 23 * 60;
/** Max orders cancelled per sweep (bounds work per tick). */
const BATCH_LIMIT = 200;

@Injectable()
export class StaleOrderSweeperService implements OnModuleDestroy {
  private readonly logger = new Logger(StaleOrderSweeperService.name);
  private destroyed = false;

  constructor(
    private readonly orders: OrderRepository,
    private readonly orderService: OrderService,
  ) {}

  onModuleDestroy(): void {
    this.destroyed = true;
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async run(): Promise<void> {
    if (this.destroyed) return;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error('stale-order sweep error', err instanceof Error ? err.stack : String(err));
    }
  }

  /**
   * Cancel every `pending_payment` order older than the TTL. Returns the number cancelled.
   * Public so the integration test can drive it without waiting for the cron.
   */
  async sweep(): Promise<number> {
    const ttlMinutes = this.ttlMinutes();
    const cutoff = new Date(Date.now() - ttlMinutes * 60_000);
    const stale = await this.orders.findStalePendingPayment(cutoff, BATCH_LIMIT);

    let cancelled = 0;
    for (const o of stale) {
      try {
        await this.orderService.transition(o.tenantId, o.id, 'cancelled', {
          changedBy: null,
          note: `Auto-cancelled: payment not completed within ${ttlMinutes} min`,
          expectedFrom: 'pending_payment',
          precondition: async (tx) => {
            // TOCTOU guard: a `payment_intent.processing` (SEPA) can land between the scan above
            // and this lock WITHOUT changing order status, so expectedFrom can't see it. Re-check
            // for an in-flight payment under the row lock and abort if so — never cancel a clearing SEPA.
            if (await this.orders.hasInFlightPayment(o.tenantId, o.id, tx)) {
              throw new ConflictException(`Order ${o.id} has an in-flight payment; skip cancel`);
            }
          },
        });
        cancelled++;
      } catch (err) {
        // 409 → it was paid/cancelled concurrently OR has an in-flight payment; skip quietly.
        if (!(err instanceof ConflictException)) {
          this.logger.error(`failed to auto-cancel order ${o.id}`, err);
        }
      }
    }
    if (cancelled > 0) {
      this.logger.log(`auto-cancelled ${cancelled} stale unpaid order(s)`);
    }
    return cancelled;
  }

  private ttlMinutes(): number {
    const raw = Number(process.env.UNPAID_ORDER_TTL_MINUTES);
    const ttl = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MINUTES;
    // Clamp below the Stripe idempotency-key lifetime so a stale order can never outlive its key.
    return Math.min(ttl, MAX_TTL_MINUTES);
  }
}
