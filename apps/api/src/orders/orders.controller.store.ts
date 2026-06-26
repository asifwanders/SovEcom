/**
 * Store checkout controller.
 *
 * `POST /store/v1/carts/:cartId/checkout` turns a cart into an order. Authorised exactly
 * like the other `/store/v1/carts` routes: the caller presents the `sov_cart` cookie or a
 * customer JWT, and `CartService.findByIdAuthorised` enforces ownership BEFORE the order is
 * created (no createFromCart on a cart you don't own). The created order is serialized with
 * no internal leakage (no tenant_id, no raw metadata).
 */
import { Controller, Post, Param, Req, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalCustomerAuthGuard } from '../customers/auth/optional-customer-auth.guard';
import { CurrentCustomer } from '../customers/auth/customer-current.decorator';
import type { AuthenticatedCustomer } from '../customers/auth/authenticated-customer';
import { StoreTenantService } from '../catalog/store-tenant.service';
import { CartService } from '../cart/cart.service';
import { OrderService } from './orders.service';
import type { Order } from '../database/schema/orders';

const CART_COOKIE = 'sov_cart';

@ApiTags('Store / Checkout')
@Public()
@UseGuards(OptionalCustomerAuthGuard)
@Controller('store/v1/carts')
export class OrdersStoreController {
  constructor(
    private readonly cartService: CartService,
    private readonly orderService: OrderService,
    private readonly storeTenant: StoreTenantService,
  ) {}

  @Post(':cartId/checkout')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create an order from the cart (requires cart-token cookie or customer JWT)',
  })
  async checkout(
    @Param('cartId') cartId: string,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);

    // Authorise ownership of the cart FIRST (403/404 on a cart the caller doesn't own),
    // mirroring every other store cart route. createFromCart then re-loads + locks it.
    await this.cartService.findByIdAuthorised(tenantId, cartId, token, customer);

    const order = await this.orderService.createFromCart(tenantId, cartId, { customer });
    // Surface the guest-lookup token EXACTLY ONCE so a guest can later view the order
    // via GET /store/v1/orders/by-number/:orderNumber with the X-Order-Token header. Never returned again.
    return { ...this.serialize(order), guestAccessToken: order.guestAccessToken };
  }

  private extractCartToken(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, string> | undefined;
    return cookies?.[CART_COOKIE];
  }

  /** Serialise the order for the storefront — no internal columns (tenant_id, metadata). */
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
      discountCode: order.discountCode,
      shippingMethod: order.shippingMethod,
      shippingAddress: order.shippingAddress,
      billingAddress: order.billingAddress,
      placedAt: order.placedAt,
      createdAt: order.createdAt,
    };
  }
}
