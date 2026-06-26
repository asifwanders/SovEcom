/**
 * core domain events → subscribed module workers.
 *
 * Mirrors the 2.12b webhook fan-out (`webhooks/webhook-event.listener.ts`): maps internal
 * EventEmitter2 domain events to the canonical names a module may subscribe to, and hands each to
 * the {@link ModuleEventBus} which delivers it (tenant-scoped, fire-and-forget) to every enabled
 * worker subscribed to that event. The payloads match the webhook payloads (a deliberately
 * minimal, non-PII projection — ids + status, not full records).
 */
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { OrderCreatedEvent } from '../../orders/events/order-created.event';
import { OrderStatusChangedEvent } from '../../orders/events/order-status-changed.event';
import { RefundIssuedEvent } from '../../payments/refunds/events/refund-issued.event';
import { ProductCreatedEvent } from '../../catalog/events/product-created.event';
import { ProductUpdatedEvent } from '../../catalog/events/product-updated.event';
import { ProductDeletedEvent } from '../../catalog/events/product-deleted.event';
import { ProductPriceChangedEvent } from '../../catalog/events/product-price-changed.event';
import { ProductStockChangedEvent } from '../../catalog/events/product-stock-changed.event';
import { ModuleEventBus } from './module-event-bus';
import type {
  ProductPriceChangedPayload,
  ProductStockChangedPayload,
  SubscribableCoreEvent,
} from './module-events';

@Injectable()
export class ModuleEventListener {
  constructor(private readonly bus: ModuleEventBus) {}

  @OnEvent(OrderCreatedEvent.EVENT_NAME)
  onOrderCreated(e: OrderCreatedEvent): void {
    this.bus.deliverCoreEvent('order.created', e.tenantId, {
      orderId: e.orderId,
      customerId: e.customerId,
    });
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
    this.bus.deliverCoreEvent('refund.issued', e.tenantId, {
      refundId: e.refundId,
      orderId: e.orderId,
      amount: e.amount,
      currency: e.currency,
    });
  }

  @OnEvent(ProductCreatedEvent.EVENT)
  onProductCreated(e: ProductCreatedEvent): void {
    this.bus.deliverCoreEvent('product.created', e.tenantId, { productId: e.productId });
  }
  @OnEvent(ProductUpdatedEvent.EVENT)
  onProductUpdated(e: ProductUpdatedEvent): void {
    this.bus.deliverCoreEvent('product.updated', e.tenantId, { productId: e.productId });
  }
  @OnEvent(ProductDeletedEvent.EVENT)
  onProductDeleted(e: ProductDeletedEvent): void {
    this.bus.deliverCoreEvent('product.deleted', e.tenantId, { productId: e.productId });
  }

  /**
   * Follow-up B2 — observational commerce signals. The payloads are the minimal module-facing
   * contracts (see `module-events.ts`): price carries old+new (public catalog data); stock carries
   * a boolean ONLY (never the level). Both are emitted by core POST-COMMIT, so a subscribed module
   * only ever OBSERVES — it never enters the transactional inventory/price path.
   */
  @OnEvent(ProductPriceChangedEvent.EVENT)
  onProductPriceChanged(e: ProductPriceChangedEvent): void {
    const payload: ProductPriceChangedPayload = {
      eventId: e.eventId,
      productId: e.productId,
      variantId: e.variantId,
      oldPriceMinor: e.oldPriceMinor,
      newPriceMinor: e.newPriceMinor,
      currency: e.currency,
    };
    this.bus.deliverCoreEvent('product.price_changed', e.tenantId, payload);
  }

  @OnEvent(ProductStockChangedEvent.EVENT)
  onProductStockChanged(e: ProductStockChangedEvent): void {
    const payload: ProductStockChangedPayload = {
      eventId: e.eventId,
      productId: e.productId,
      variantId: e.variantId,
      available: e.available,
    };
    this.bus.deliverCoreEvent('product.stock_changed', e.tenantId, payload);
  }

  private onStatus(event: SubscribableCoreEvent, e: OrderStatusChangedEvent): void {
    this.bus.deliverCoreEvent(event, e.tenantId, {
      orderId: e.orderId,
      status: e.toStatus,
      previousStatus: e.fromStatus,
    });
  }
}
