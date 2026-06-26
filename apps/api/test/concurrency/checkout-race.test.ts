/**
 * Checkout race.
 *
 * The cart `SELECT … FOR UPDATE` lock in createFromCart must serialise two simultaneous
 * checkouts of the SAME cart into exactly ONE order with exactly ONE stock decrement —
 * the second caller, arriving after the first commits and flips the cart to `converted`,
 * must 409. Stock can NEVER be decremented without a committed order (the headline money
 * invariant). Uses the shared-promise barrier so both checkouts genuinely race the lock.
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

/** Seed a shipping zone + flat rate (FR) so the cart can pick a method. */
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

/** Drive a guest cart to checkout-ready via HTTP (so the Redis blob is authoritative). */
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
    .send({ email: `race-${Date.now()}@test.invalid` });
  return cartId;
}

describe('Checkout race — one cart, one order', () => {
  it('two simultaneous checkouts of the same cart → exactly one order, one decrement', async () => {
    const { variantId } = await seedVariant(h, { stock: 5, priceAmount: 1000 });
    await seedShippingRate('EUR');
    const cartId = await makeReadyCart(variantId, 'EUR');

    const stockBefore = (
      await h.client<{ stock_quantity: number }[]>`
        select stock_quantity from product_variants where id = ${variantId}
      `
    )[0]!.stock_quantity;

    const { fulfilled, rejected } = await runConcurrently(
      2,
      () => h.orders.createFromCart(T, cartId, {}),
      'checkout same cart',
    );

    // Exactly one order created; the loser 409s (ConflictException).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictException);

    // Exactly ONE order row, and stock decremented by the single ordered quantity only.
    const orders = await h.client<{ n: number }[]>`select count(*)::int as n from orders`;
    expect(orders[0]!.n).toBe(1);

    const stockAfter = (
      await h.client<{ stock_quantity: number }[]>`
        select stock_quantity from product_variants where id = ${variantId}
      `
    )[0]!.stock_quantity;
    expect(stockAfter).toBe(stockBefore - 1);

    // The single confirmed reservation proves consume ran exactly once.
    const confirmed = await h.client<{ n: number }[]>`
      select count(*)::int as n from inventory_reservations
      where cart_id = ${cartId} and status = 'confirmed'
    `;
    expect(confirmed[0]!.n).toBe(1);
  });
});
