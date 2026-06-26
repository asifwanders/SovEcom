/**
 * PUBLIC guest order lookup. Route: /store/v1/orders/by-number/:orderNumber.
 *
 * A guest who checked out WITHOUT an account has no durable identity, so they view their order via
 * the per-order token returned once at checkout. `@Public()` skips the GLOBAL admin guards and there
 * is NO customer guard — this is intentionally unauthenticated, gated solely by the token.
 *
 * SECURITY (no IDOR / no enumeration): unknown order number, an order without a token, and a wrong
 * token all resolve to the same 404 (the service throws NotFoundException for every failure, and
 * the token is constant-time-compared). The response is the storefront-safe serialization — no
 * internal columns, and never the token hash.
 *
 * The token is passed in the `X-Order-Token` header, never the query string:
 * a URL-borne secret would be written to request logs and leak to browser history. A header avoids this.
 */
import { Controller, Get, Headers, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { StoreTenantService } from '../catalog/store-tenant.service';
import { OrderService } from './orders.service';
import type { Order } from '../database/schema/orders';
import type { OrderItem } from '../database/schema/order_items';

@ApiTags('Store / Orders')
@Public()
@Controller('store/v1/orders')
export class OrdersGuestStoreController {
  constructor(
    private readonly orders: OrderService,
    private readonly storeTenant: StoreTenantService,
  ) {}

  @Get('by-number/:orderNumber')
  @ApiOperation({
    summary: 'Guest order lookup by order number + X-Order-Token header (404 on any mismatch)',
  })
  async byNumber(
    @Param('orderNumber') orderNumber: string,
    @Headers('x-order-token') token?: string,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const { order, items } = await this.orders.findForGuest(tenantId, orderNumber, token);
    return { ...this.serialize(order), items: items.map((i) => this.serializeItem(i)) };
  }

  /** Storefront-safe view — no internal columns, never the guest_token_hash. */
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
      lineTotalAmount: item.lineTotalAmount,
    };
  }
}
