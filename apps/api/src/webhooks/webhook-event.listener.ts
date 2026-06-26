/**
 * maps internal EventEmitter2 domain events to canonical outbound
 * webhook events and fans each out to the tenant's matching subscriptions. FIRE-AND-FORGET: a
 * fan-out failure is logged but never breaks the commercial flow. Tenant-scoped via the payload.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderCreatedEvent } from '../orders/events/order-created.event';
import { OrderStatusChangedEvent } from '../orders/events/order-status-changed.event';
import { RefundIssuedEvent } from '../payments/refunds/events/refund-issued.event';
import { ProductCreatedEvent } from '../catalog/events/product-created.event';
import { ProductUpdatedEvent } from '../catalog/events/product-updated.event';
import { ProductDeletedEvent } from '../catalog/events/product-deleted.event';
import { WebhookDeliveryService } from './webhook-delivery.service';
import type { WebhookEventName } from './webhook.types';

@Injectable()
export class WebhookEventListener {
  private readonly logger = new Logger(WebhookEventListener.name);

  constructor(private readonly delivery: WebhookDeliveryService) {}

  @OnEvent(OrderCreatedEvent.EVENT_NAME)
  onOrderCreated(e: OrderCreatedEvent): void {
    this.fan('order.created', e.tenantId, { orderId: e.orderId, customerId: e.customerId });
  }

  @OnEvent('order.paid')
  onOrderPaid(e: OrderStatusChangedEvent): void {
    this.onStatus('order.paid', e);
  }
  @OnEvent('order.shipped')
  onOrderShipped(e: OrderStatusChangedEvent): void {
    this.onStatus('order.shipped', e);
  }
  @OnEvent('order.cancelled')
  onOrderCancelled(e: OrderStatusChangedEvent): void {
    this.onStatus('order.cancelled', e);
  }
  @OnEvent('order.refunded')
  onOrderRefunded(e: OrderStatusChangedEvent): void {
    this.onStatus('order.refunded', e);
  }
  @OnEvent('order.partially_refunded')
  onOrderPartiallyRefunded(e: OrderStatusChangedEvent): void {
    this.onStatus('order.partially_refunded', e);
  }

  @OnEvent(RefundIssuedEvent.EVENT_NAME)
  onRefundIssued(e: RefundIssuedEvent): void {
    this.fan('refund.issued', e.tenantId, {
      refundId: e.refundId,
      orderId: e.orderId,
      amount: e.amount,
      currency: e.currency,
      creditNoteId: e.creditNoteId,
    });
  }

  @OnEvent(ProductCreatedEvent.EVENT)
  onProductCreated(e: ProductCreatedEvent): void {
    this.fan('product.created', e.tenantId, { productId: e.productId });
  }
  @OnEvent(ProductUpdatedEvent.EVENT)
  onProductUpdated(e: ProductUpdatedEvent): void {
    this.fan('product.updated', e.tenantId, { productId: e.productId });
  }
  @OnEvent(ProductDeletedEvent.EVENT)
  onProductDeleted(e: ProductDeletedEvent): void {
    this.fan('product.deleted', e.tenantId, { productId: e.productId });
  }

  private onStatus(event: WebhookEventName, e: OrderStatusChangedEvent): void {
    this.fan(event, e.tenantId, {
      orderId: e.orderId,
      status: e.toStatus,
      previousStatus: e.fromStatus,
    });
  }

  /** Fire-and-forget fan-out; an enqueue failure must never break the emitting flow. */
  private fan(event: WebhookEventName, tenantId: string, data: unknown): void {
    void this.delivery.enqueue(tenantId, event, data).catch((err: unknown) => {
      this.logger.warn(
        `webhook fan-out ${event} failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    });
  }
}
