/**
 * EmailComposer: load the data an email needs and render it.
 *
 * ONE code path for both the event listeners and admin resend: `compose(type, orderId, ref, extra)`.
 * The recipient is always the order's `email` (a single order load serves every type). `extra`
 * carries event-only data (refund amount/currency/creditNoteId); on RESEND `extra` is absent and
 * the composer re-derives the refund amount/currency from the refund row (the credit-note
 * reference is event-path only — there is no refund→credit-note link in the schema).
 */
import { Injectable, Logger } from '@nestjs/common';
import { OrderRepository } from '../orders/order.repository';
import { RefundRepository } from '../payments/refunds/refund.repository';
import { InvoiceService } from '../invoices/invoice.service';
import { CustomersRepository } from '../customers/customers.repository';
import {
  renderOrderConfirmation,
  type OrderEmailLine,
} from './templates/order-confirmation.template';
import { renderOrderShipped } from './templates/order-shipped.template';
import { renderRefundIssued } from './templates/refund-issued.template';
import { DEFAULT_LOCALE, resolveEmailLocale, type EmailLocale } from './i18n/email-locale';
import type { AddressLike, RenderedEmail } from './templates/_layout';
import type { EmailType } from './email.types';

export interface ComposeExtra {
  amount?: number;
  currency?: string;
  creditNoteId?: string | null;
}

export interface ComposedEmail {
  type: EmailType;
  recipient: string;
  orderId: string;
  referenceId: string | null;
  rendered: RenderedEmail;
}

@Injectable()
export class EmailComposer {
  private readonly logger = new Logger(EmailComposer.name);

  constructor(
    private readonly orders: OrderRepository,
    private readonly refunds: RefundRepository,
    private readonly invoices: InvoiceService,
    private readonly customers: CustomersRepository,
  ) {}

  /**
   * Resolve the render locale for an order's recipient.
   *
   * Reads the customer's stored `customers.locale` and resolves it (null-safe, total) to a
   * supported locale, falling back to the default ('en') when the order is a guest order, the
   * customer can't be loaded, the column is null, or it holds an unrecognized value. This is
   * BEST-EFFORT and MUST NEVER throw — any failure degrades to the default locale so the
   * checkout/order email path is never blocked by locale resolution.
   */
  private async resolveLocale(tenantId: string, customerId: string | null): Promise<EmailLocale> {
    if (!customerId) return DEFAULT_LOCALE;
    try {
      const customer = await this.customers.findActiveById(tenantId, customerId);
      return resolveEmailLocale(customer?.locale);
    } catch (err) {
      this.logger.warn(
        `locale resolution failed — falling back to ${DEFAULT_LOCALE}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return DEFAULT_LOCALE;
    }
  }

  /** Build the email for `type`, or null if the data it needs has gone (order/refund missing). */
  async compose(
    tenantId: string,
    type: EmailType,
    orderId: string,
    referenceId: string | null,
    extra?: ComposeExtra,
  ): Promise<ComposedEmail | null> {
    const order = await this.orders.findById(tenantId, orderId);
    if (!order) {
      this.logger.warn(`compose ${type}: order not found — skipping`);
      return null;
    }
    const recipient = order.email;
    const shippingAddress = order.shippingAddress as AddressLike | null;
    const locale = await this.resolveLocale(tenantId, order.customerId);

    if (type === 'order_confirmation') {
      const items = await this.orders.itemsForOrder(tenantId, orderId);
      const rendered = renderOrderConfirmation({
        orderNumber: order.orderNumber,
        currency: order.currency,
        subtotalAmount: order.subtotalAmount,
        discountAmount: order.discountAmount,
        shippingAmount: order.shippingAmount,
        taxAmount: order.taxAmount,
        totalAmount: order.totalAmount,
        items: items.map(
          (i): OrderEmailLine => ({
            productTitle: i.productTitle,
            sku: i.sku,
            quantity: i.quantity,
            unitPriceAmount: i.unitPriceAmount,
            lineTotalAmount: i.lineTotalAmount,
          }),
        ),
        shippingAddress,
        locale,
      });
      return { type, recipient, orderId, referenceId: null, rendered };
    }

    if (type === 'order_shipped') {
      const rendered = renderOrderShipped({
        orderNumber: order.orderNumber,
        shippingAddress,
        locale,
      });
      return { type, recipient, orderId, referenceId: null, rendered };
    }

    // refund_issued
    let amount = extra?.amount;
    let currency = extra?.currency;
    if ((amount === undefined || currency === undefined) && referenceId) {
      const refund = await this.refunds.findById(tenantId, referenceId);
      if (!refund) {
        this.logger.warn(`compose refund_issued: refund ${referenceId} not found — skipping`);
        return null;
      }
      amount = refund.amount;
      currency = refund.currency;
    }
    if (amount === undefined || currency === undefined) {
      this.logger.warn('compose refund_issued: missing amount/currency — skipping');
      return null;
    }
    const creditNoteReference = extra?.creditNoteId
      ? await this.creditNoteReference(tenantId, extra.creditNoteId)
      : null;
    const rendered = renderRefundIssued({
      orderNumber: order.orderNumber,
      amount,
      currency,
      creditNoteReference,
      locale,
    });
    return { type, recipient, orderId, referenceId, rendered };
  }

  /** `series-number` display reference for a credit note, or null if it can't be loaded. */
  private async creditNoteReference(
    tenantId: string,
    creditNoteId: string,
  ): Promise<string | null> {
    const cn = await this.invoices.findById(tenantId, creditNoteId);
    return cn ? `${cn.series}-${cn.invoiceNumber}` : null;
  }
}
