/**
 * Store payment-intent controller.
 *
 * `POST /store/v1/carts/:cartId/payment-intent` — anonymous (cart cookie OR customer JWT),
 * authorised exactly like `/checkout`: the caller must own the cart. Returns the Stripe
 * `clientSecret` the browser Element confirms with. The endpoint is a card-testing target, so
 * the service applies per-IP + per-cart velocity caps and returns only opaque errors.
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
import { PaymentsService } from './payments.service';

const CART_COOKIE = 'sov_cart';

@ApiTags('Store / Payments')
@Public()
@UseGuards(OptionalCustomerAuthGuard)
@Controller('store/v1/carts')
export class PaymentsStoreController {
  constructor(
    private readonly cartService: CartService,
    private readonly payments: PaymentsService,
    private readonly storeTenant: StoreTenantService,
  ) {}

  @Post(':cartId/payment-intent')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a Stripe payment intent for the cart (cart-token cookie or customer JWT)',
  })
  async createPaymentIntent(
    @Param('cartId') cartId: string,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);

    // Authorise cart ownership FIRST (403/404 on a cart the caller doesn't own) — mirrors
    // /checkout. The service then load-or-creates the order under its own cart lock.
    await this.cartService.findByIdAuthorised(tenantId, cartId, token, customer);

    return this.payments.createPaymentIntentForCart(
      tenantId,
      cartId,
      { customer },
      this.clientIp(req),
    );
  }

  private extractCartToken(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, string> | undefined;
    return cookies?.[CART_COOKIE];
  }

  /** Best-effort client IP for the velocity cap (Express `trust proxy` governs `req.ip`). */
  private clientIp(req: Request): string {
    return req.ip ?? 'unknown';
  }
}
