/**
 * Per-customer discount usage limit must NOT be bypassable via guest checkout.
 *
 * `usage_limit_per_customer = 1` (and no total limit) was previously enforced only by
 * customer_id, so a guest (customer_id NULL) could re-redeem the code indefinitely. The fix
 * keys the per-customer limit on the normalized guest EMAIL too.
 *
 * Full AppModule against real Postgres + Redis (reuses the cart/orders harness). Drives real
 * guest checkouts end-to-end with a controlled email + applied code.
 *
 * Blocks a second same-email guest either at apply-by-code (422, the code is now ineligible
 * for that email) or, if it slips past eval, at checkout (409). Both are acceptable "blocked"
 * outcomes; what must NOT happen is a 201 second redemption.
 */
import request from 'supertest';
import {
  bootCartApp,
  resetOrderState,
  seedSimpleProduct,
  seedShippingRate,
  extractCartTokenCookie,
  type CartHarness,
} from './_orders-harness';
import { seedDiscount } from '../cart/_cart-harness';

let h: CartHarness;

beforeAll(async () => {
  h = await bootCartApp();
}, 30_000);

afterAll(async () => {
  await h.app.close();
  await h.client.end();
});

beforeEach(async () => {
  await resetOrderState(h);
}, 10_000);

const ADDRESS = {
  name: 'Guest Buyer',
  line1: '1 rue de Test',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};

type GuestOutcome =
  | { ok: true; orderId: string }
  | { ok: false; stage: 'apply' | 'checkout'; status: number };

/**
 * Drive a fresh GUEST cart toward a placed order with the given email + discount code.
 * Returns a normalized outcome: ok+orderId on a completed order, or the blocking stage
 * (apply-by-code or checkout) and its HTTP status when the per-customer limit refuses it.
 */
async function guestCheckout(
  variantId: string,
  email: string,
  code: string,
): Promise<GuestOutcome> {
  const created = await request(h.http()).post('/store/v1/carts').send({ currency: 'EUR' });
  const cartId = created.body.cartId as string;
  const cookie = extractCartTokenCookie(created);

  await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cookie)
    .send({ variantId, quantity: 1 })
    .expect(201);

  await seedShippingRate(h, 'EUR');

  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-address`)
    .set('Cookie', cookie)
    .send(ADDRESS)
    .expect(200);

  const rates = await request(h.http())
    .get(`/store/v1/carts/${cartId}/shipping-rates`)
    .set('Cookie', cookie);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-method`)
    .set('Cookie', cookie)
    .send({ shippingRateId: rates.body[0].id })
    .expect(200);

  await request(h.http())
    .post(`/store/v1/carts/${cartId}/email`)
    .set('Cookie', cookie)
    .send({ email })
    .expect(200);

  // Apply-by-code: a guest who already redeemed this once-per-customer code is now
  // INELIGIBLE at eval time (perGuestUsage keyed on the normalized email) → 422.
  const apply = await request(h.http())
    .post(`/store/v1/carts/${cartId}/discounts`)
    .set('Cookie', cookie)
    .send({ code });
  if (apply.status !== 200) {
    return { ok: false, stage: 'apply', status: apply.status };
  }

  // Even if eval let it through, the checkout-time FOR UPDATE re-check refuses it (409).
  const checkout = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cookie)
    .send({});
  if (checkout.status !== 201) {
    return { ok: false, stage: 'checkout', status: checkout.status };
  }
  return { ok: true, orderId: checkout.body.id as string };
}

describe('guest discount usage_limit_per_customer', () => {
  it('blocks a second guest redemption with the SAME email but allows a different email', async () => {
    await seedDiscount(h, {
      code: 'ONCE',
      type: 'percentage',
      value: 1000, // 10%
      usage_limit_per_customer: 1,
      usage_limit_total: null,
    });
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 50 });

    // First guest order with email X → OK.
    const first = await guestCheckout(variantId, 'guest-x@test.invalid', 'ONCE');
    expect(first.ok).toBe(true);

    // Second guest order with the SAME email X → blocked (apply 422 or checkout 409).
    const second = await guestCheckout(variantId, 'guest-x@test.invalid', 'ONCE');
    expect(second.ok).toBe(false);
    if (!second.ok) expect([422, 409]).toContain(second.status);

    // Casing must not bypass it — normalized comparison.
    const casing = await guestCheckout(variantId, 'GUEST-X@TEST.INVALID', 'ONCE');
    expect(casing.ok).toBe(false);

    // A DIFFERENT email is still allowed.
    const other = await guestCheckout(variantId, 'guest-y@test.invalid', 'ONCE');
    expect(other.ok).toBe(true);
  }, 30_000);
});
