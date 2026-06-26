/**
 * Discount validation must judge a code on its OWN pre-clamp contribution,
 * not on the headroom left after automatic discounts.
 *
 * When an active automatic discount already zeroes the cart, an otherwise-valid code
 * clamps to 0 in the combined evaluation and was wrongly 422'd. The code's standalone
 * eligibility (it discounts something on its own) is what the apply gate must check.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { DiscountsService } from './discounts.service';
import type { DiscountsRepository } from './discounts.repository';
import type { DatabaseService } from '../database/database.service';
import type { CartState } from '../cart/cart.types';
import type { Discount } from '../database/schema/discounts';

function makeDiscount(over: Partial<Discount>): Discount {
  return {
    id: 'd-code',
    tenantId: 't1',
    name: 'X',
    code: 'SAVE10',
    type: 'percentage',
    value: 1000, // 10%
    currency: null,
    minCartAmount: null,
    appliesTo: 'all',
    targetIds: null,
    customerSegment: null,
    stackable: true,
    usageLimitTotal: null,
    usageLimitPerCustomer: null,
    usedCount: 0,
    startsAt: null,
    endsAt: null,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Discount;
}

function makeCart(): CartState {
  return {
    id: 'c1',
    tenantId: 't1',
    customerId: null,
    sessionToken: 'tok',
    currency: 'EUR',
    status: 'active',
    guestEmail: null,
    items: [
      {
        id: 'i1',
        variantId: 'v1',
        quantity: 1,
        unitPriceAmount: 1000,
        currency: 'EUR',
        productTitle: 'Product 1',
        variantTitle: null,
        options: {},
        sku: 'SKU-v1',
        productSlug: 'product-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    shippingAddress: null,
    billingAddress: null,
    shippingRateId: null,
    shippingAmount: 0,
    discountCode: null,
    totals: {
      subtotal: 1000,
      shipping: 0,
      discountTotal: 0,
      taxTotal: 0,
      grandTotal: 1000,
      currency: 'EUR',
    },
    expiresAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('DiscountsService.validateCodeForCart (pre-clamp eligibility)', () => {
  function makeService(opts: { code: Discount | null }) {
    // A 100%-off automatic discount that, in the COMBINED evaluation, consumes all the
    // cart headroom so the explicit code clamps to 0. Returned
    // by loadCandidates alongside the explicit code so the OLD code path reproduces the bug.
    const auto = makeDiscount({ id: 'd-auto', code: null, value: 10000 }); // 100%
    const repo = {
      findByCode: jest.fn().mockResolvedValue(opts.code),
      loadCandidates: jest.fn().mockResolvedValue(opts.code ? [auto, opts.code] : [auto]),
      customerHasPriorOrder: jest.fn(),
      resolveVariantProductsAndCategories: jest.fn().mockResolvedValue({
        variantToProduct: new Map([['v1', 'p1']]),
        productCategories: new Map(),
      }),
      // not used for a guest cart with no email, but stubbed defensively
      customerIsB2b: jest.fn().mockResolvedValue(false),
      perCustomerUsage: jest.fn().mockResolvedValue(new Map()),
      perGuestUsage: jest.fn().mockResolvedValue(new Map()),
    } as unknown as DiscountsRepository;
    const db = {} as DatabaseService;
    return new DiscountsService(repo, db);
  }

  it('accepts a valid code even when an automatic discount already zeroes the cart', async () => {
    // The cart subtotal is fully consumed by automatic discounts — but the explicit
    // code, evaluated on its OWN, still discounts 10% of 1000 = 100. It must be accepted.
    const service = makeService({ code: makeDiscount({}) });
    await expect(service.validateCodeForCart('t1', makeCart(), 'SAVE10')).resolves.toBeUndefined();
  });

  it('still 422s a genuinely ineligible code (its own contribution is zero)', async () => {
    // A fixed discount in a non-matching currency contributes nothing on its own.
    const service = makeService({
      code: makeDiscount({ type: 'fixed', value: 500, currency: 'USD' }),
    });
    await expect(service.validateCodeForCart('t1', makeCart(), 'SAVE10')).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('still 422s an unknown code', async () => {
    const service = makeService({ code: null });
    await expect(service.validateCodeForCart('t1', makeCart(), 'NOPE')).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  // the unknown and the valid-but-ineligible cases must throw the SAME opaque message
  // so the apply endpoint is not a coupon-enumeration oracle (an attacker cannot tell which codes
  // exist). The message must NOT echo the submitted code either.
  it('returns an IDENTICAL opaque 422 for an unknown vs an ineligible code', async () => {
    const unknownSvc = makeService({ code: null });
    const ineligibleSvc = makeService({
      code: makeDiscount({ type: 'fixed', value: 500, currency: 'USD' }),
    });

    const unknownErr = await unknownSvc.validateCodeForCart('t1', makeCart(), 'NOPE').then(
      () => {
        throw new Error('expected validateCodeForCart to reject');
      },
      (e) => e as UnprocessableEntityException,
    );
    const ineligibleErr = await ineligibleSvc.validateCodeForCart('t1', makeCart(), 'SAVE10').then(
      () => {
        throw new Error('expected validateCodeForCart to reject');
      },
      (e) => e as UnprocessableEntityException,
    );

    expect(unknownErr.message).toBe(ineligibleErr.message);
    expect(unknownErr.message).not.toContain('NOPE');
    expect(unknownErr.message).not.toContain('SAVE10');
  });
});
