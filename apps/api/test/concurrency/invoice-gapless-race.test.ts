/**
 * invoice GAPLESS-under-concurrency race (LEGAL/MONEY-CRITICAL).
 *
 * The fiscal headline: N DISTINCT orders issued SIMULTANEOUSLY for the same tenant+series
 * must produce a CONTIGUOUS block of invoice numbers — NO gaps, NO duplicates. The
 * `invoice_counters` row is taken `FOR UPDATE` inside the issuing tx, so the N issuers
 * serialise on that lock and each reads a distinct, consecutive `next_value`; the partial
 * unique index on (tenant, order, type) is the backstop against any double-issue.
 *
 * Proven invariants after the race:
 *   - exactly N invoices exist (one per order — count(invoices) === N);
 *   - the N invoice_numbers are a CONTIGUOUS set with no gaps and no duplicates;
 *   - the counter advanced to exactly N+1 (no number burned, none reused).
 *
 * Uses the shared-promise barrier so all N issuances genuinely race the counter lock.
 */
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
import { InvoiceService } from '../../src/invoices/invoice.service';

let h: ConcurrencyHarness;
let invoices: InvoiceService;
const T = DEFAULT_TENANT_ID;

beforeAll(async () => {
  h = await bootConcurrencyApp();
  invoices = h.app.get(InvoiceService);
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

/** Drive a guest cart to checkout-ready via HTTP. Returns the cart id. */
async function makeReadyCart(variantId: string, currency: string): Promise<string> {
  const created = await request(h.http()).post('/store/v1/carts').send({ currency });
  const cartId = created.body.cartId as string;
  const cookie = (created.headers['set-cookie'] as unknown as string[]).find((c) =>
    c.startsWith('sov_cart='),
  )!;
  const set = (req: request.Test): request.Test => req.set('Cookie', cookie);

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
    email: `inv-race-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`,
  });
  return cartId;
}

describe('Invoice gapless race — N simultaneous issuances, contiguous numbers, no gaps/dupes', () => {
  it('5 orders issued at once → 5 invoices with a contiguous, gapless, unique number block', async () => {
    const N = 5;
    const { variantId, currency } = await seedVariant(h, { stock: 50, priceAmount: 1000 });
    await seedShippingRate(currency);

    // Create N distinct, persisted orders (one per ready cart). These are sequential set-up;
    // the RACE is the simultaneous issuance below.
    const orderIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const cartId = await makeReadyCart(variantId, currency);
      const order = await h.orders.createFromCart(T, cartId, {});
      orderIds.push(order.id);
    }
    // issueForOrder now refuses a non-paid order (defensive paid-status guard). Mark these
    // seeded orders paid directly in the DB (no event → no listener auto-issue racing our
    // direct issuance) so the gapless race below tests ONLY the counter-lock serialisation.
    await h.client`
      update orders set status = 'paid' where tenant_id = ${T} and id = any(${orderIds})
    `;

    // Fire all N issuances SIMULTANEOUSLY (shared-promise barrier). The invoice_counters
    // FOR UPDATE lock serialises them; each must get a distinct consecutive number.
    const { fulfilled, rejected } = await runConcurrently(
      N,
      (i) => invoices.issueForOrder(T, orderIds[i]!),
      'invoice gapless issuance',
    );

    // Every issuance succeeded (the lock serialises; it never deadlocks or double-issues).
    expect(rejected).toHaveLength(0);
    expect(fulfilled).toHaveLength(N);
    expect(fulfilled.every((r) => r.value.created)).toBe(true);

    // Exactly N invoices persisted (one per order).
    const count = await h.client<{ n: number }[]>`
      select count(*)::int as n from invoices where tenant_id = ${T} and type = 'invoice'
    `;
    expect(count[0]!.n).toBe(N);

    // The numeric sequence portion (YYYY-NNNNNN) is a CONTIGUOUS 1..N block: no gaps, no dups.
    const rows = await h.client<{ invoice_number: string }[]>`
      select invoice_number from invoices where tenant_id = ${T} and type = 'invoice'
    `;
    const seqs = rows.map((r) => Number(r.invoice_number.split('-')[1])).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_unused, i) => i + 1));
    // No duplicates (a Set of the numbers is the same size).
    expect(new Set(seqs).size).toBe(N);

    // The counter advanced to exactly N+1 — no number burned, none reused.
    const counter = await h.client<{ next_value: string }[]>`
      select next_value from invoice_counters where tenant_id = ${T} and series = 'STD'
    `;
    expect(Number(counter[0]!.next_value)).toBe(N + 1);
  });
});
