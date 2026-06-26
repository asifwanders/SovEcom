/**
 * WebhookDeliveryService.
 *
 * `enqueue` fans an event out to one `pending` delivery per matching active subscription.
 * `processDue` (driven by the @Cron worker, public so tests call it) claims due deliveries, signs +
 * POSTs each (SSRF-guarded, DNS-rebinding-proof), and records the outcome with backoff/exhaust.
 * `retry` is the admin retry-from-failure.
 */
import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { AeadService } from '../auth/crypto/aead.service';
import { WebhookSubscriptionRepository } from './webhook-subscription.repository';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { buildSignatureHeaders } from './webhook-signer';
import { postWebhook } from './webhook-http';
import { BACKOFF_SECONDS, type WebhookEnvelope, type WebhookEventName } from './webhook.types';
import type { WebhookDelivery } from '../database/schema/webhook_deliveries';

const CLAIM_LIMIT = 20;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Per-delivery hard deadline (overridable for tests). */
function deliveryTimeoutMs(): number {
  const raw = Number(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * The lease a claimed row holds before it's re-claimable. It MUST exceed the
 * worst-case time one drain spends on a full batch — CLAIM_LIMIT deliveries each taking
 * up to deliveryTimeoutMs() — or a second instance re-claims a lease-expired-but-still-
 * delivering row and double-delivers (the in-memory `running` guard is per-process only,
 * and recordResult has no ownership guard). `+ 20s` is slack for per-row signing/DB work.
 * Exported so the invariant can be asserted in a guard test.
 */
export function leaseMs(): number {
  return CLAIM_LIMIT * deliveryTimeoutMs() + 20_000;
}

/** Exported for the invariant guard test. */
export const WEBHOOK_CLAIM_LIMIT = CLAIM_LIMIT;
export { deliveryTimeoutMs };

@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger(WebhookDeliveryService.name);

  constructor(
    private readonly subs: WebhookSubscriptionRepository,
    private readonly deliveries: WebhookDeliveryRepository,
    private readonly aead: AeadService,
  ) {}

  /** Fan an event out: one pending delivery row per active subscription that wants this event. */
  async enqueue(tenantId: string, event: WebhookEventName, data: unknown): Promise<void> {
    const active = await this.subs.listActiveForTenant(tenantId);
    const matching = active.filter((s) => (s.events as string[]).includes(event));
    if (matching.length === 0) return;
    await this.deliveries.insertMany(
      matching.map((s) => ({
        id: uuidv7(),
        tenantId,
        subscriptionId: s.id,
        event,
        payload: data as object,
        status: 'pending' as const,
      })),
    );
  }

  /**
   * Claim + deliver all currently-due rows. Returns how many were processed (for tests/metrics).
   *
   * the whole drain runs under a cross-process advisory lock so only ONE instance
   * drains at a time (the in-memory `running` guard is per-process). A second instance whose
   * drain overlaps acquires nothing and returns 0 — so a lease-expired-but-still-delivering
   * row can't be re-claimed and double-delivered. The lease itself is sized to exceed the
   * worst-case batch time (see leaseMs()), defence-in-depth behind the lock.
   */
  async processDue(limit = CLAIM_LIMIT): Promise<number> {
    const release = await this.deliveries.tryDrainLock();
    if (!release) return 0; // another instance is draining
    try {
      const due = await this.deliveries.claimDue(limit, leaseMs());
      for (const delivery of due) {
        await this.deliverOne(delivery);
      }
      return due.length;
    } finally {
      await release();
    }
  }

  /** Admin retry-from-failure: re-arm a failed/exhausted delivery (tenant-scoped). */
  async retry(tenantId: string, deliveryId: string): Promise<void> {
    const found = await this.deliveries.findById(tenantId, deliveryId);
    if (!found) throw new NotFoundException(`Webhook delivery ${deliveryId} not found`);
    const reset = await this.deliveries.markForRetry(tenantId, deliveryId);
    if (!reset) {
      throw new ConflictException(
        `Delivery ${deliveryId} is not in a retryable state (${found.status})`,
      );
    }
  }

  /** Sign + POST one delivery; record delivered / failed(+backoff) / exhausted. Never throws. */
  private async deliverOne(delivery: WebhookDelivery): Promise<void> {
    const attempts = delivery.attempts + 1;
    const sub = await this.subs.findById(delivery.tenantId, delivery.subscriptionId);
    if (!sub) {
      // Subscription vanished (cascade should have removed the delivery) — stop retrying.
      await this.exhaust(delivery.id, attempts, null, 'subscription no longer exists');
      return;
    }

    let secret: string;
    try {
      secret = this.aead.decrypt(sub.secret, sub.id);
    } catch {
      await this.exhaust(delivery.id, attempts, null, 'secret decrypt failed');
      return;
    }

    const envelope: WebhookEnvelope = {
      id: delivery.id,
      event: delivery.event,
      occurredAt: delivery.createdAt.toISOString(),
      data: delivery.payload,
    };
    const body = JSON.stringify(envelope);
    const headers = buildSignatureHeaders(secret, body);

    try {
      const res = await postWebhook(sub.url, body, headers, deliveryTimeoutMs());
      if (res.statusCode >= 200 && res.statusCode < 300) {
        await this.deliveries.recordResult(delivery.id, {
          status: 'delivered',
          attempts,
          responseCode: res.statusCode,
          lastError: null,
          nextRetryAt: delivery.nextRetryAt,
        });
        return;
      }
      await this.fail(delivery, attempts, res.statusCode, `HTTP ${res.statusCode}`);
    } catch (err) {
      await this.fail(delivery, attempts, null, this.errorMessage(err));
    }
  }

  /** A retryable failure: schedule the next attempt, or exhaust if the backoff schedule ran out. */
  private async fail(
    delivery: WebhookDelivery,
    attempts: number,
    responseCode: number | null,
    lastError: string,
  ): Promise<void> {
    if (attempts > BACKOFF_SECONDS.length) {
      await this.exhaust(delivery.id, attempts, responseCode, lastError);
      return;
    }
    const delaySec = BACKOFF_SECONDS[attempts - 1]!;
    await this.deliveries.recordResult(delivery.id, {
      status: 'failed',
      attempts,
      responseCode,
      lastError,
      nextRetryAt: new Date(Date.now() + delaySec * 1000),
    });
  }

  private async exhaust(
    id: string,
    attempts: number,
    responseCode: number | null,
    lastError: string,
  ): Promise<void> {
    this.logger.warn(`webhook delivery ${id} exhausted after ${attempts} attempt(s)`);
    await this.deliveries.recordResult(id, {
      status: 'exhausted',
      attempts,
      responseCode,
      lastError,
      nextRetryAt: new Date(),
    });
  }

  /** Short, capped error string for the log (transport/status — no secret/signature). */
  private errorMessage(err: unknown): string {
    const msg = err instanceof Error ? err.message : 'unknown delivery error';
    return msg.length > 500 ? msg.slice(0, 500) : msg;
  }
}
