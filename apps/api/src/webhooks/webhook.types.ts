/**
 * webhook domain constants & types.
 */
import type { deliveryStatusEnum } from '../database/schema/_enums';

export type DeliveryStatus = (typeof deliveryStatusEnum.enumValues)[number];

/** The canonical outbound event names a subscriber may subscribe to in v1 (orders+refunds+products). */
export const WEBHOOK_EVENTS = [
  'order.created',
  'order.paid',
  'order.shipped',
  'order.cancelled',
  'order.refunded',
  'order.partially_refunded',
  'refund.issued',
  'product.created',
  'product.updated',
  'product.deleted',
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/**
 * Retry backoff schedule (seconds) — exponential-ish, capped at 24h. After a failed
 * attempt N the next retry is `BACKOFF_SECONDS[N-1]` later; once N exceeds the schedule the delivery
 * is `exhausted`. So the schedule length + 1 is the max attempt count.
 */
export const BACKOFF_SECONDS: readonly number[] = [60, 300, 1800, 7200, 21600, 86400];

/** The wire envelope: signed + POSTed. `id` is the delivery id (receiver-side idempotency key). */
export interface WebhookEnvelope {
  id: string;
  event: string;
  occurredAt: string;
  data: unknown;
}
