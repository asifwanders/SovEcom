/**
 * POST /store/v1/carts/:cartId/discounts (applyDiscount) must be rate-limited (per-IP +
 * per-cart, fail-closed) so it is not a coupon-enumeration / brute-force oracle. The throttle runs
 * BEFORE the cart/discount engine is touched; a tripped limit yields 429 and never applies a code.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { CartController } from './cart.controller';
import type { CartService } from './cart.service';
import type { StoreTenantService } from '../catalog/store-tenant.service';
import type { AuditService } from '../audit/audit.service';
import type { RateLimitService } from '../auth/services/rate-limit.service';
import type { CartState } from './cart.types';

function makeCartState(): CartState {
  return {
    id: 'c1',
    customerId: null,
    currency: 'EUR',
    status: 'active',
    guestEmail: null,
    items: [],
    shippingAddress: null,
    billingAddress: null,
    shippingRateId: null,
    discountCode: 'SAVE10',
    totals: {
      subtotal: 0,
      shipping: 0,
      discountTotal: 0,
      taxTotal: 0,
      grandTotal: 0,
      currency: 'EUR',
    },
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as CartState;
}

describe('CartController.applyDiscount —(rate-limit the apply-discount route)', () => {
  function setup() {
    const applyDiscount = jest.fn(async () => makeCartState());
    const cartService = { applyDiscount } as unknown as CartService;
    const storeTenant = { getDefaultTenantId: jest.fn(async () => 't1') } as unknown as StoreTenantService; // prettier-ignore
    const audit = { record: jest.fn(async () => undefined) } as unknown as AuditService;

    // Allow the first 2 hits (across the two checks), then block — simplest deterministic stub.
    let calls = 0;
    const check = jest.fn(async () => {
      calls += 1;
      return { allowed: calls <= 4, count: calls, degraded: false };
    });
    const rateLimit = { check } as unknown as RateLimitService;

    const controller = new CartController(cartService, storeTenant, audit, rateLimit);
    const req = { ip: '1.2.3.4', headers: {}, cookies: {} } as never;
    return { controller, req, applyDiscount, check };
  }

  it('checks BOTH a per-IP and a per-cart bucket', async () => {
    const { controller, req, check } = setup();
    await controller.applyDiscount('c1', { code: 'SAVE10' } as never, req, undefined);
    const keys = (check.mock.calls as unknown as Array<[string, ...unknown[]]>).map((c) => c[0]);
    expect(keys).toEqual(expect.arrayContaining(['discount:ip:1.2.3.4', 'discount:cart:c1']));
  });

  it('applies a legitimate code while within budget', async () => {
    const { controller, req, applyDiscount } = setup();
    await controller.applyDiscount('c1', { code: 'SAVE10' } as never, req, undefined);
    expect(applyDiscount).toHaveBeenCalledTimes(1);
  });

  it('throws 429 once the velocity cap trips and never applies the code', async () => {
    const { controller, req, applyDiscount } = setup();
    // First two calls consume 4 buckets (allowed); the third trips (calls 5/6 > 4).
    await controller.applyDiscount('c1', { code: 'SAVE10' } as never, req, undefined);
    await controller.applyDiscount('c1', { code: 'SAVE10' } as never, req, undefined);
    const err = await controller
      .applyDiscount('c1', { code: 'SAVE10' } as never, req, undefined)
      .catch((e) => e as HttpException);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    // The blocked request must NOT have applied the third discount.
    expect(applyDiscount).toHaveBeenCalledTimes(2);
  });
});
