/**
 * subscribes to the post-commit domain events and sends the matching
 * transactional email. FIRE-AND-FORGET: a send failure is logged + recorded in `email_logs`, but
 * NEVER propagates back into the commercial flow (same posture as the reset email / the 2.11 PDF
 * render). Each handler is tenant-scoped via the event payload.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderCreatedEvent } from '../../orders/events/order-created.event';
import { OrderStatusChangedEvent } from '../../orders/events/order-status-changed.event';
import { RefundIssuedEvent } from '../../payments/refunds/events/refund-issued.event';
import { EmailNotificationService } from '../email-notification.service';

@Injectable()
export class OrderEmailListener {
  private readonly logger = new Logger(OrderEmailListener.name);

  constructor(private readonly emails: EmailNotificationService) {}

  @OnEvent(OrderCreatedEvent.EVENT_NAME)
  async onOrderCreated(event: OrderCreatedEvent): Promise<void> {
    await this.safe('order_confirmation', () =>
      this.emails.dispatch(event.tenantId, 'order_confirmation', event.orderId, null),
    );
  }

  @OnEvent(OrderStatusChangedEvent.eventName('shipped'))
  async onOrderShipped(event: OrderStatusChangedEvent): Promise<void> {
    await this.safe('order_shipped', () =>
      this.emails.dispatch(event.tenantId, 'order_shipped', event.orderId, null),
    );
  }

  @OnEvent(RefundIssuedEvent.EVENT_NAME)
  async onRefundIssued(event: RefundIssuedEvent): Promise<void> {
    await this.safe('refund_issued', () =>
      this.emails.dispatch(event.tenantId, 'refund_issued', event.orderId, event.refundId, {
        amount: event.amount,
        currency: event.currency,
        creditNoteId: event.creditNoteId,
      }),
    );
  }

  /** Run a dispatch, swallowing any error (the email path must never break the order flow). */
  private async safe(kind: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(
        `email ${kind} dispatch failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }
}
