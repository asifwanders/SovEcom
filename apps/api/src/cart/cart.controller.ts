/**
 * Cart controller (storefront, /store/v1/carts).
 *
 * All routes are @Public (global JwtAuthGuard passes them through). Cart token
 * is issued as an httpOnly cookie. The POST /customer route ALSO requires a
 * customer JWT via CustomerAuthGuard.
 *
 * The cart token is extracted from the `sov_cart` cookie per-request and passed
 * down to CartService for validation; the service enforces authorisation.
 */
import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { CustomerAuthGuard } from '../customers/auth/customer-auth.guard';
import { OptionalCustomerAuthGuard } from '../customers/auth/optional-customer-auth.guard';
import { CurrentCustomer } from '../customers/auth/customer-current.decorator';
import type { AuthenticatedCustomer } from '../customers/auth/authenticated-customer';
import { StoreTenantService } from '../catalog/store-tenant.service';
import { AuditService } from '../audit/audit.service';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { CartService } from './cart.service';
import {
  CreateCartDto,
  AddCartItemDto,
  UpdateCartItemDto,
  SetAddressDto,
  SetShippingMethodDto,
  SetGuestEmailDto,
} from './dto/cart.dto';
import { ApplyDiscountDto } from '../discounts/dto/discount.dto';
import type { CartState } from './cart.types';

const CART_COOKIE = 'sov_cart';
const COOKIE_MAX_AGE = 8 * 24 * 60 * 60 * 1000; // 8 days ms

// apply-discount velocity caps (coupon enumeration / brute-force defence). Mirrors the
// PaymentsService.enforceVelocity pattern: per-IP + per-cart fixed-window counters, fail-closed.
const DISCOUNT_IP_LIMIT = 20;
const DISCOUNT_CART_LIMIT = 10;
const DISCOUNT_WINDOW_SECONDS = 60;

@ApiTags('Store / Cart')
@Public()
// Optional customer auth on every route: attaches req.customer when a valid
// customer JWT is present (so a logged-in customer can act on their cart without
// the cookie), but never rejects an anonymous guest (cart-token cookie path).
// associateCustomer additionally applies the MANDATORY CustomerAuthGuard.
@UseGuards(OptionalCustomerAuthGuard)
@Controller('store/v1/carts')
export class CartController {
  constructor(
    private readonly cartService: CartService,
    private readonly storeTenant: StoreTenantService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // ── Create ───────────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an empty guest cart; sets httpOnly cart-token cookie' })
  async create(@Body() dto: CreateCartDto, @Res({ passthrough: true }) res: Response) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const cart = await this.cartService.create(tenantId, dto.currency ?? 'EUR');
    this.setCartCookie(res, cart.sessionToken);
    return { cartId: cart.id, currency: cart.currency };
  }

  // ── Get ──────────────────────────────────────────────────────────────────────

  @Get(':cartId')
  @ApiOperation({ summary: 'Get cart (requires cart-token cookie or customer JWT)' })
  async findOne(
    @Param('cartId') cartId: string,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    const cart = await this.cartService.findByIdAuthorised(tenantId, cartId, token, customer);
    return this.serialize(cart);
  }

  // ── Add item ─────────────────────────────────────────────────────────────────

  @Post(':cartId/items')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add an item to the cart' })
  async addItem(
    @Param('cartId') cartId: string,
    @Body() dto: AddCartItemDto,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    const cart = await this.cartService.addItem(
      tenantId,
      cartId,
      token,
      customer,
      dto.variantId,
      dto.quantity,
    );
    return this.serialize(cart);
  }

  // ── Update item ───────────────────────────────────────────────────────────────

  @Patch(':cartId/items/:itemId')
  @ApiOperation({ summary: 'Update item quantity' })
  async updateItem(
    @Param('cartId') cartId: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateCartItemDto,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    const cart = await this.cartService.updateItem(
      tenantId,
      cartId,
      itemId,
      token,
      customer,
      dto.quantity,
    );
    return this.serialize(cart);
  }

  // ── Remove item ───────────────────────────────────────────────────────────────

  @Delete(':cartId/items/:itemId')
  @ApiOperation({ summary: 'Remove an item from the cart' })
  async removeItem(
    @Param('cartId') cartId: string,
    @Param('itemId') itemId: string,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    const cart = await this.cartService.removeItem(tenantId, cartId, itemId, token, customer);
    return this.serialize(cart);
  }

  // ── Shipping address ──────────────────────────────────────────────────────────

  @Post(':cartId/shipping-address')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set shipping address; recomputes totals' })
  async setShippingAddress(
    @Param('cartId') cartId: string,
    @Body() dto: SetAddressDto,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    const cart = await this.cartService.setShippingAddress(tenantId, cartId, token, customer, dto);
    return this.serialize(cart);
  }

  // ── Billing address ───────────────────────────────────────────────────────────

  @Post(':cartId/billing-address')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set billing address' })
  async setBillingAddress(
    @Param('cartId') cartId: string,
    @Body() dto: SetAddressDto,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    const cart = await this.cartService.setBillingAddress(tenantId, cartId, token, customer, dto);
    return this.serialize(cart);
  }

  // ── Shipping rates (available for the cart destination) ───────────────────────

  @Get(':cartId/shipping-rates')
  @ApiOperation({ summary: 'List shipping rates available for the cart destination' })
  async getShippingRates(
    @Param('cartId') cartId: string,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    return this.cartService.getShippingRates(tenantId, cartId, token, customer);
  }

  // ── Shipping method ───────────────────────────────────────────────────────────

  @Post(':cartId/shipping-method')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set shipping method; recomputes totals' })
  async setShippingMethod(
    @Param('cartId') cartId: string,
    @Body() dto: SetShippingMethodDto,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    const cart = await this.cartService.setShippingMethod(
      tenantId,
      cartId,
      token,
      customer,
      dto.shippingRateId,
    );
    return this.serialize(cart);
  }

  // ── Guest email ───────────────────────────────────────────────────────────────

  @Post(':cartId/email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set guest email on the cart' })
  async setEmail(
    @Param('cartId') cartId: string,
    @Body() dto: SetGuestEmailDto,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    const cart = await this.cartService.setGuestEmail(tenantId, cartId, token, customer, dto.email);
    return this.serialize(cart);
  }

  // ── Discounts (apply / remove by code) ────────────────────────────────────────

  @Post(':cartId/discounts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Apply a discount code; recomputes totals (422 if ineligible)' })
  async applyDiscount(
    @Param('cartId') cartId: string,
    @Body() dto: ApplyDiscountDto,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    // throttle BEFORE touching the cart/discount engine: an unrate-limited apply route is
    // a coupon-enumeration / brute-force oracle (paired with the now-opaque 422 in DiscountsService).
    await this.enforceDiscountVelocity(req.ip, cartId);
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    const cart = await this.cartService.applyDiscount(tenantId, cartId, token, customer, dto.code);
    await this.recordDiscountAudit(req, tenantId, cartId, customer, 'cart.discount_applied', dto.code); // prettier-ignore
    return this.serialize(cart);
  }

  @Delete(':cartId/discounts/:code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a discount code; recomputes totals' })
  async removeDiscount(
    @Param('cartId') cartId: string,
    @Param('code') code: string,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    const cart = await this.cartService.removeDiscount(tenantId, cartId, token, customer, code);
    await this.recordDiscountAudit(req, tenantId, cartId, customer, 'cart.discount_removed', code);
    return this.serialize(cart);
  }

  // ── Associate customer (merge) ────────────────────────────────────────────────

  @Post(':cartId/customer')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CustomerAuthGuard)
  @ApiOperation({ summary: 'Associate authenticated customer; triggers guest→customer merge' })
  async associateCustomer(
    @Param('cartId') cartId: string,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    const cart = await this.cartService.associateCustomer(tenantId, cartId, token, customer);
    return this.serialize(cart);
  }

  // ── Abandon ───────────────────────────────────────────────────────────────────

  @Delete(':cartId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Clear / abandon the cart' })
  async abandon(
    @Param('cartId') cartId: string,
    @Req() req: Request,
    @CurrentCustomer() customer: AuthenticatedCustomer | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tenantId = await this.storeTenant.getDefaultTenantId();
    const token = this.extractCartToken(req);
    await this.cartService.abandon(tenantId, cartId, token, customer);
    res.clearCookie(CART_COOKIE);
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private extractCartToken(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, string> | undefined;
    return cookies?.[CART_COOKIE];
  }

  /**
   * per-IP + per-cart velocity caps on apply-discount (coupon enumeration / brute-force
   * defence), mirroring PaymentsService.enforceVelocity. RateLimitService fails CLOSED, so a Redis
   * outage blocks rather than opens the gate. The 429 carries NO enumerable detail.
   */
  private async enforceDiscountVelocity(ip: string | undefined, cartId: string): Promise<void> {
    const [byIp, byCart] = await Promise.all([
      this.rateLimit.check(`discount:ip:${ip ?? 'unknown'}`, {
        limit: DISCOUNT_IP_LIMIT,
        windowSeconds: DISCOUNT_WINDOW_SECONDS,
      }),
      this.rateLimit.check(`discount:cart:${cartId}`, {
        limit: DISCOUNT_CART_LIMIT,
        windowSeconds: DISCOUNT_WINDOW_SECONDS,
      }),
    ]);
    if (!byIp.allowed || !byCart.allowed) {
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * Audit a cart discount apply/remove. These are @Public store routes, so the
   * global AuditInterceptor (which keys off req.user) does not fire — record
   * directly here. Actor is the customer when authenticated, else anonymous.
   * Best-effort: AuditService.record swallows its own failures.
   */
  private async recordDiscountAudit(
    req: Request,
    tenantId: string,
    cartId: string,
    customer: AuthenticatedCustomer | undefined,
    action: string,
    code: string,
  ): Promise<void> {
    await this.audit.record({
      tenantId,
      actorType: customer ? 'customer' : 'anonymous',
      actorId: customer?.id,
      action,
      resourceType: 'carts',
      resourceId: cartId,
      changes: { code },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  private setCartCookie(res: Response, token: string): void {
    res.cookie(CART_COOKIE, token, {
      httpOnly: true,
      // Lax is INTENTIONAL (not a weakening): the CSRF defense for credentialed cross-origin cart
      // mutations is the explicit CORS allowlist (STORE_ORIGIN with credentials:true in main.ts) — only
      // the known storefront origin can read the response of a credentialed request. `Strict` would drop
      // this cookie on cross-origin navigation INTO the storefront (e.g. following an email/PDP link),
      // breaking the guest cart. The storefront + API deploy under one registrable domain (
      // operational invariant), so Lax still carries the cookie on same-site requests.
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });
  }

  private serialize(cart: CartState): Record<string, unknown> {
    return {
      id: cart.id,
      customerId: cart.customerId,
      currency: cart.currency,
      status: cart.status,
      guestEmail: cart.guestEmail,
      items: cart.items.map((item) => ({
        id: item.id,
        variantId: item.variantId,
        quantity: item.quantity,
        unitPriceAmount: item.unitPriceAmount,
        currency: item.currency,
        // Display-identity snapshot so the storefront renders the human-readable
        // product/variant name + options + a PDP link, never the raw variant UUID.
        productTitle: item.productTitle,
        variantTitle: item.variantTitle,
        options: item.options,
        sku: item.sku,
        productSlug: item.productSlug,
      })),
      shippingAddress: cart.shippingAddress,
      billingAddress: cart.billingAddress,
      shippingRateId: cart.shippingRateId,
      discountCode: cart.discountCode,
      // Normalise the additive reverse-charge flag to an explicit boolean so the
      // storefront always reads a concrete value — legacy/recovery totals that omit it serialise as false.
      totals: { ...cart.totals, reverseCharge: cart.totals.reverseCharge ?? false },
      expiresAt: cart.expiresAt,
      createdAt: cart.createdAt,
      updatedAt: cart.updatedAt,
    };
  }
}
