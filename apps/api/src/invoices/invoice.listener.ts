/**
 * InvoiceListener.
 *
 * Subscribes to `order.paid` (emitted post-commit by OrderService.transition) and issues
 * the legal invoice. The event is the ONLY link from OrdersModule → InvoicesModule, so
 * there is no module cycle (OrdersModule never imports InvoicesModule).
 *
 * IDEMPOTENT downstream: a re-emitted/retried `order.paid` is a no-op at the service layer
 * (pre-check + partial unique index), so a duplicate event never double-issues.
 *
 * FAILURE HANDLING: log loudly, do NOT re-throw out of the handler (the event bus has no
 * caller to surface to; a failed render leaves the invoice issued with storage_key null and
 * downloads render on demand). The order is already paid.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OrderStatusChangedEvent } from '../orders/events/order-status-changed.event';
import { InvoiceService } from './invoice.service';

@Injectable()
export class InvoiceListener {
  private readonly logger = new Logger(InvoiceListener.name);

  constructor(private readonly invoices: InvoiceService) {}

  @OnEvent('order.paid')
  async onOrderPaid(event: OrderStatusChangedEvent): Promise<void> {
    try {
      const { created } = await this.invoices.issueForOrder(event.tenantId, event.orderId);
      if (created) {
        this.logger.log(`Issued invoice for order ${event.orderId}`);
      }
    } catch (err) {
      this.logger.error(`Failed to issue invoice for order ${event.orderId}`, err);
    }
  }
}
