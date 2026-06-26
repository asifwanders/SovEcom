/**
 * Discount usage-limit race.
 *
 * The HEADLINE money test: a discount with `usage_limit_total = 1` redeemed by TWO
 * simultaneous checkouts (two DIFFERENT carts, each applying the same code) must end
 * with EXACTLY ONE order created and ONE 409 — never two redemptions. The
 * `consumeDiscountUsages` step row-LOCKS the discount `FOR UPDATE`, re-checks the live
 * used_count, and FAILS the loser inside its tx so the whole order rolls back. Proven
 * invariants after the race:
 *   - exactly one fulfilled, one rejected (ConflictException);
 *   - discounts.used_count === 1 (never 2 — no over-redemption);
 *   - exactly one discount_usages row;
 *   - used_count === count(discount_usages) (the consume stayed consistent).
 *
 * Uses the shared-promise barrier so both checkouts genuinely race the discount lock.
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

/** Seed a shipping zone + flat rate so a FR cart can pick a method. */
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

/** Seed a discount with the given overrides; returns its id. */
async function seedDiscountRow(overrides: Record<string, unknown>): Promise<string> {
  const id = newId();
  const d = {
    code: null as string | null,
    name: 'Race',
    type: 'percentage',
    value: 1000,
    currency: null as string | null,
    min_cart_amount: null as number | null,
    applies_to: 'all',
    customer_segment: null as string | null,
    stackable: false,
    usage_limit_total: null as number | null,
    usage_limit_per_customer: null as number | null,
    active: true,
    ...overrides,
  };
  await h.client`
    insert into discounts (
      id, tenant_id, code, name, type, value, currency, min_cart_amount,
      applies_to, target_ids, customer_segment, stackable,
      usage_limit_total, usage_limit_per_customer, active
    ) values (
      ${id}, ${T}, ${d.code}, ${d.name}, ${d.type}, ${d.value}, ${d.currency},
      ${d.min_cart_amount}, ${d.applies_to}, ${null}, ${d.customer_segment},
      ${d.stackable}, ${d.usage_limit_total}, ${d.usage_limit_per_customer}, ${d.active}
    )
  `;
  return id;
}

/** Drive a guest cart to checkout-ready via HTTP and apply `code`. Returns the cart id. */
async function makeReadyCartWithCode(
  variantId: string,
  currency: string,
  code: string,
): Promise<string> {
  const created = await request(h.http()).post('/store/v1/carts').send({ currency });
  const cartId = created.body.cartId as string;
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('sov_cart='),
  )!;
  const set = (req: request.Test) => req.set('Cookie', cookie);

  await set(request(h.http()).post(`/store/v1/carts/${cartId}/items`)).send({
    variantId,
    quantity: 1,
  });
  await set(request(h.http()).post(`/store/v1/carts/${cartId}/shipping-address`)).send({
    name: 'B',
    line1: '1 rue',
    city: 'Paris',
    postalCode: '75001',
    country: 'FR',
  });
  const rates = await set(request(h.http()).get(`/store/v1/carts/${cartId}/shipping-rates`));
  await set(request(h.http()).post(`/store/v1/carts/${cartId}/shipping-method`)).send({
    shippingRateId: rates.body[0].id,
  });
  await set(request(h.http()).post(`/store/v1/carts/${cartId}/email`)).send({
    email: `disc-race-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`,
  });
  const apply = await set(request(h.http()).post(`/store/v1/carts/${cartId}/discounts`)).send({
    code,
  });
  if (apply.status !== 200) {
    throw new Error(`apply code failed: ${apply.status} ${JSON.stringify(apply.body)}`);
  }
  return cartId;
}

describe('Discount race — usage_limit_total never over-redeemed', () => {
  it('two simultaneous checkouts of a 1-use code → exactly one order, one 409, used_count 1', async () => {
    // Plenty of stock so STOCK never gates — the discount lock is the sole arbiter.
    const { variantId, currency } = await seedVariant(h, { stock: 50, priceAmount: 1000 });
    await seedShippingRate(currency);
    const discountId = await seedDiscountRow({
      code: 'LAST1',
      type: 'percentage',
      value: 1000, // 10%
      usage_limit_total: 1,
    });

    // Two DIFFERENT carts, each applying the same one-use code.
    const cartA = await makeReadyCartWithCode(variantId, currency, 'LAST1');
    const cartB = await makeReadyCartWithCode(variantId, currency, 'LAST1');

    const { fulfilled, rejected } = await runConcurrently(
      2,
      (i) => h.orders.createFromCart(T, i === 0 ? cartA : cartB, {}),
      'discount 1-use redemption',
    );

    // Exactly one checkout succeeds; the loser 409s (discount no longer available).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictException);

    // used_count is EXACTLY 1 — the usage_limit_total was never exceeded.
    const disc = await h.client<{ used_count: number }[]>`
      select used_count from discounts where id = ${discountId}
    `;
    expect(disc[0]!.used_count).toBe(1);

    // Exactly one redemption row, and it equals used_count (consume stayed consistent).
    const usages = await h.client<{ n: number }[]>`
      select count(*)::int as n from discount_usages where discount_id = ${discountId}
    `;
    expect(usages[0]!.n).toBe(1);
    expect(usages[0]!.n).toBe(disc[0]!.used_count);

    // Exactly one order persisted (the winner); the loser's tx rolled back entirely.
    const orders = await h.client<{ n: number }[]>`select count(*)::int as n from orders`;
    expect(orders[0]!.n).toBe(1);
  });
});
