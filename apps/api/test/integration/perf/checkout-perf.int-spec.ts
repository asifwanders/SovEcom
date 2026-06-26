/**
 * full cart→order perf budget.
 *
 * Doc 12 §2.14 exit criterion: the full checkout flow completes under 2s (excluding the Stripe
 * network round-trip, which is mocked here). This times ONLY the buyer-facing HTTP sequence —
 * create cart, add item, set shipping address + method, set email, POST /checkout — against real
 * Postgres + Redis. Fixtures (product + shipping rate) are seeded ONCE in `beforeEach`, OUTSIDE the
 * timed region, so the measurement is the buyer flow and nothing else (a real storefront does not
 * create shipping zones during checkout). A warmup run primes JIT + the DB/Redis pools; we assert
 * the MEDIAN of N runs against the 2000ms budget (robust to a single GC pause) and log the spread.
 * The budget is a wide margin over the typical local figure, so it guards against catastrophic
 * regressions without flaking on slower CI runners.
 */
import { performance } from 'perf_hooks';
import request from 'supertest';
import {
  bootPaymentsApp,
  resetOrderState,
  resetStripeMock,
  seedSimpleProduct,
  extractCartTokenCookie,
  type PaymentsHarness,
} from '../payments/_payments-harness';
import { seedShippingRate } from '../cart/_cart-harness';

const BUDGET_MS = 2000;
const MEASURED_RUNS = 3;
const ADDRESS = {
  name: 'Jane Buyer',
  line1: '1 rue de Test',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};

let h: PaymentsHarness;
let variantId: string;

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
  // Fixtures seeded ONCE, outside any timed region: ample stock so warmup + every measured run
  // completes, and a single shipping rate the buyer flow can select (no per-run seeding).
  ({ variantId } = await seedSimpleProduct(h, { price: 1000, stock: 1000 }));
  await seedShippingRate(h, 'EUR');
});

/** One full buyer flow — only HTTP the storefront actually performs. Returns elapsed ms. */
async function timeFullCheckout(): Promise<number> {
  const start = performance.now();

  const created = await request(h.http())
    .post('/store/v1/carts')
    .send({ currency: 'EUR' })
    .expect(201);
  const cartId = created.body.cartId as string;
  const cookie = extractCartTokenCookie(created);

  await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cookie)
    .send({ variantId, quantity: 2 })
    .expect(201);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-address`)
    .set('Cookie', cookie)
    .send(ADDRESS)
    .expect(200);

  const rates = await request(h.http())
    .get(`/store/v1/carts/${cartId}/shipping-rates`)
    .set('Cookie', cookie)
    .expect(200);
  const rateId = rates.body[0]?.id as string;
  if (!rateId) throw new Error(`no shipping rate available: ${JSON.stringify(rates.body)}`);

  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-method`)
    .set('Cookie', cookie)
    .send({ shippingRateId: rateId })
    .expect(200);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/email`)
    .set('Cookie', cookie)
    .send({ email: 'buyer@test.invalid' })
    .expect(200);

  await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cookie)
    .send({})
    .expect(201);

  return performance.now() - start;
}

describe('checkout performance', () => {
  it(`completes the full cart→order flow under the ${BUDGET_MS}ms budget`, async () => {
    // Warmup (not measured): primes JIT + connection pools.
    await timeFullCheckout();

    const samples: number[] = [];
    for (let i = 0; i < MEASURED_RUNS; i++) {
      samples.push(await timeFullCheckout());
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const max = sorted[sorted.length - 1]!;

    // eslint-disable-next-line no-console
    console.log(
      `[checkout-perf] median=${median.toFixed(0)}ms max=${max.toFixed(0)}ms ` +
        `samples=[${samples.map((s) => s.toFixed(0)).join(', ')}]ms budget=${BUDGET_MS}ms`,
    );

    expect(median).toBeLessThan(BUDGET_MS);
  }, 30_000);
});
