/**
 * Store Order-read Controller (SECURITY-CRITICAL: no IDOR).
 * Routes: /store/v1/orders. Requires a customer JWT (CustomerAuthGuard) — this is the customer's
 * own order history. Guests with no account look up a single order via OrdersGuestStoreController.
 * `@Public` here only skips the global admin guards; CustomerAuthGuard re-imposes customer auth,
 * and every query scopes strictly to `customer.id` from the guard-set principal — never a
 * path/body id. Another customer's order id resolves to nothing (404), so an order id is not
 * an enumeration oracle.
 *
 * The checkout POST lives in OrdersStoreController (/store/v1/carts/:id/checkout); this
 * controller is read-only.
 */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { CustomerAuthGuard } from '../customers/auth/customer-auth.guard';
import { CurrentCustomer } from '../customers/auth/customer-current.decorator';
import type { AuthenticatedCustomer } from '../customers/auth/authenticated-customer';
import { OrderService } from './orders.service';
import type { Order } from '../database/schema/orders';
import type { OrderItem } from '../database/schema/order_items';

@ApiTags('Store / Orders')
@Public()
@UseGuards(CustomerAuthGuard)
@Controller('store/v1/orders')
export class OrdersReadStoreController {
  constructor(private readonly orders: OrderService) {}

  @Get()
  @ApiOperation({ summary: 'List my orders (newest first; my own only)' })
  async list(@CurrentCustomer() customer: AuthenticatedCustomer) {
    const rows = await this.orders.listForCustomer(customer.tenantId, customer.id);
    return rows.map((o) => this.serialize(o));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of MY orders (404 on any order not mine — no IDOR)' })
  async detail(@CurrentCustomer() customer: AuthenticatedCustomer, @Param('id') id: string) {
    const { order, items } = await this.orders.findForCustomer(customer.tenantId, customer.id, id);
    return { ...this.serialize(order), items: items.map((i) => this.serializeItem(i)) };
  }

  /** Storefront order view — no internal columns (tenant_id, metadata, notes). */
  private serialize(order: Order): Record<string, unknown> {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      currency: order.currency,
      email: order.email,
      subtotalAmount: order.subtotalAmount,
      discountAmount: order.discountAmount,
      shippingAmount: order.shippingAmount,
      taxAmount: order.taxAmount,
      totalAmount: order.totalAmount,
      refundedAmount: order.refundedAmount,
      discountCode: order.discountCode,
      shippingMethod: order.shippingMethod,
      trackingNumber: order.trackingNumber,
      carrier: order.carrier,
      shippingAddress: order.shippingAddress,
      billingAddress: order.billingAddress,
      placedAt: order.placedAt,
      createdAt: order.createdAt,
    };
  }

  private serializeItem(item: OrderItem): Record<string, unknown> {
    return {
      id: item.id,
      productTitle: item.productTitle,
      variantTitle: item.variantTitle,
      sku: item.sku,
      quantity: item.quantity,
      unitPriceAmount: item.unitPriceAmount,
      taxRate: item.taxRate,
      taxAmount: item.taxAmount,
      lineTotalAmount: item.lineTotalAmount,
    };
  }
}
