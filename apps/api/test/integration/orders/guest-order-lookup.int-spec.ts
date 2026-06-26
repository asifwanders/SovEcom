/**
 * guest order lookup. Checkout returns a per-order token ONCE; the public
 * GET /store/v1/orders/by-number/:orderNumber (token in the X-Order-Token HEADER — never the URL,
 * so it can't leak into request logs) returns the order only with the right token, and 404s
 * identically for a wrong token / unknown number / missing token (no enumeration/IDOR).
 */
import request from 'supertest';
import {
  bootPaymentsApp,
  resetOrderState,
  resetStripeMock,
  seedSimpleProduct,
  driveCartToCheckoutReady,
  type PaymentsHarness,
} from '../payments/_payments-harness';

let h: PaymentsHarness;

beforeAll(async () => {
  h = await bootPaymentsApp();
}, 30_000);
afterAll(async () => {
  await h.app.close();
  await h.client.end();
});
beforeEach(async () => {
  await resetOrderState(h);
  await h.redis.flushdb();
  resetStripeMock();
});

/** Guest checkout → returns { orderNumber, guestAccessToken }. */
async function guestCheckout(): Promise<{ orderNumber: string; token: string }> {
  const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
  const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 2);
  const co = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cartCookie)
    .send({})
    .expect(201);
  return { orderNumber: co.body.orderNumber as string, token: co.body.guestAccessToken as string };
}

describe('guest order lookup', () => {
  it('checkout returns a guest token; lookup with the right token returns the order', async () => {
    const { orderNumber, token } = await guestCheckout();
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');

    const res = await request(h.http())
      .get(`/store/v1/orders/by-number/${orderNumber}`)
      .set('X-Order-Token', token)
      .expect(200);
    expect(res.body.orderNumber).toBe(orderNumber);
    expect(res.body.items.length).toBeGreaterThan(0);
    // The storefront view never leaks internal/secret columns.
    expect(res.body.guestTokenHash).toBeUndefined();
    expect(res.body.tenantId).toBeUndefined();
  });

  it('404s on a WRONG token, an UNKNOWN order number, and a MISSING token (no enumeration)', async () => {
    const { orderNumber } = await guestCheckout();

    await request(h.http())
      .get(`/store/v1/orders/by-number/${orderNumber}`)
      .set('X-Order-Token', 'not-the-real-token')
      .expect(404);
    await request(h.http())
      .get(`/store/v1/orders/by-number/${orderNumber}`) // missing token header
      .expect(404);
    await request(h.http())
      .get('/store/v1/orders/by-number/NOPE-9999')
      .set('X-Order-Token', 'whatever')
      .expect(404);
  });

  it('does not expose the token again on a second checkout response field', async () => {
    // Each checkout mints its own token; tokens differ per order.
    const a = await guestCheckout();
    const b = await guestCheckout();
    expect(a.token).not.toBe(b.token);
    // a's token must not open b's order.
    await request(h.http())
      .get(`/store/v1/orders/by-number/${b.orderNumber}`)
      .set('X-Order-Token', a.token)
      .expect(404);
  });
});
