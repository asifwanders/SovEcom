/**
 * No oversell under SWEPT / expired reservations.
 *
 * The old createFromCart flipped whatever 'reserved' rows existed to confirmed with NO
 * physical re-check: two carts whose reservations were swept (TTL expiry) could both
 * decrement the last unit → negative stock. The fix re-checks PHYSICAL stock under a
 * variant FOR UPDATE lock per line, so with stock=1 at most ONE checkout succeeds and the
 * other 409s — stock never goes negative.
 *
 * Uses the shared-promise barrier so both checkouts genuinely race the variant lock.
 */
import { ConflictException } from '@nestjs/common';
import request from 'supertest';
import {
  bootConcurrencyApp,
  teardownConcurrencyApp,
  resetConcurrencyState,
  seedVariant,
  runConcurrently,
  newId,
  DEFAULT_TENANT_ID,
  type ConcurrencyHarness,
} from './harness';

let h: ConcurrencyHarness;
const T = DEFAULT_TENANT_ID;

beforeAll(async () => {
  h = await bootConcurrencyApp();
}, 60_000);

afterAll(async () => {
  await teardownConcurrencyApp(h);
});

beforeEach(async () => {
  await resetConcurrencyState(h);
}, 20_000);

/** Seed a shipping zone + flat rate (FR) so a guest cart can pick a method. */
async function seedShippingRate(currency: string): Promise<void> {
  const zoneId = newId();
  const rateId = newId();
  await h.client`
    insert into shipping_zones (id, tenant_id, name, countries)
    values (${zoneId}, ${T}, ${'EU'}, ${JSON.stringify(['FR'])}::jsonb)
  `;
  await h.client`
    insert into shipping_rates (id, tenant_id, zone_id, name, type, amount, currency)
    values (${rateId}, ${T}, ${zoneId}, ${'Standard'}, ${'flat'}, ${500}, ${currency})
  `;
}

/** Drive a guest cart (1 unit of `variantId`) to checkout-ready via HTTP. Returns its id. */
async function makeReadyCart(variantId: string, currency: string): Promise<string> {
  const created = await request(h.http()).post('/store/v1/carts').send({ currency });
  const cartId = created.body.cartId as string;
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('sov_cart='),
  )!;
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cookie)
    .send({ variantId, quantity: 1 });
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-address`)
    .set('Cookie', cookie)
    .send({ name: 'B', line1: '1 rue', city: 'Paris', postalCode: '75001', country: 'FR' });
  const rates = await request(h.http())
    .get(`/store/v1/carts/${cartId}/shipping-rates`)
    .set('Cookie', cookie);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-method`)
    .set('Cookie', cookie)
    .send({ shippingRateId: rates.body[0].id });
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/email`)
    .set('Cookie', cookie)
    .send({ email: `oversell-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid` });
  return cartId;
}

describe('Oversell race — swept reservations, stock=1, two carts', () => {
  it('at most one checkout succeeds; stock never goes negative', async () => {
    // Stock 2 so BOTH carts can reserve a unit each (the normal flow blocks a 2nd reserve
    // once stock is exhausted). Two distinct carts each hold a reservation.
    const { variantId, currency } = await seedVariant(h, { stock: 2, priceAmount: 1000 });
    await seedShippingRate(currency);
    const cartA = await makeReadyCart(variantId, currency);
    const cartB = await makeReadyCart(variantId, currency);

    // Now the real B1 scenario: physical stock dropped to 1 (another sale landed) AND both
    // carts' reservations were swept (TTL expiry) before either checked out. The OLD code
    // flipped the swept rows / nothing and oversold the last unit to NEGATIVE.
    await h.client`delete from inventory_reservations where variant_id = ${variantId}`;
    await h.client`update product_variants set stock_quantity = 1 where id = ${variantId}`;

    const { fulfilled, rejected } = await runConcurrently(
      2,
      (i) => h.orders.createFromCart(T, i === 0 ? cartA : cartB, {}),
      'oversell swept reservations',
    );

    // At MOST one succeeds; the loser 409s (insufficient stock at checkout).
    expect(fulfilled.length).toBeLessThanOrEqual(1);
    expect(fulfilled.length + rejected.length).toBe(2);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ConflictException);
    }

    // Stock never negative; exactly (1 − winners) units remain.
    const stock = (
      await h.client<{ stock_quantity: number }[]>`
        select stock_quantity from product_variants where id = ${variantId}
      `
    )[0]!.stock_quantity;
    expect(stock).toBeGreaterThanOrEqual(0);
    expect(stock).toBe(1 - fulfilled.length);

    // Order count matches the winners.
    const orders = await h.client<{ n: number }[]>`select count(*)::int as n from orders`;
    expect(orders[0]!.n).toBe(fulfilled.length);
  });
});
