/**
 * Invoice issuance failure modes (LEGAL/MONEY).
 *
 * Two fiscal-integrity invariants mandated:
 *
 *  (a) ROLLBACK LEAVES NO GAP. If issuance fails AFTER the gapless number is read inside the
 *      tx (here: the invoice INSERT throws), the whole tx rolls back — the counter increment
 *      rolls back too, so the number is NOT consumed. The NEXT successful issuance REUSES that
 *      number (no gap; the counter never advanced past it). This is the gapless guarantee that
 *      a bare Postgres sequence cannot give (sequences gap on rollback).
 *
 *  (b) CONCURRENT SAME-ORDER DOUBLE-ISSUE wastes no number. Two simultaneous issueForOrder for
 *      ONE order produce EXACTLY ONE invoice; the loser (partial-unique-index / in-tx re-check)
 *      consumes NO number — the counter advances by EXACTLY 1.
 */
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
import { InvoiceRepository } from '../../src/invoices/invoice.repository';
import request from 'supertest';

let h: ConcurrencyHarness;
let invoices: InvoiceService;
let repo: InvoiceRepository;
const T = DEFAULT_TENANT_ID;

beforeAll(async () => {
  h = await bootConcurrencyApp();
  invoices = h.app.get(InvoiceService);
  repo = h.app.get(InvoiceRepository);
}, 60_000);

afterAll(async () => {
  await teardownConcurrencyApp(h);
});

beforeEach(async () => {
  await resetConcurrencyState(h);
}, 20_000);

afterEach(() => {
  jest.restoreAllMocks();
});

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
    email: `inv-fail-${Date.now()}-${Math.random().toString(36).slice(2)}@test.invalid`,
  });
  return cartId;
}

/** Create a persisted, PAID order (issueForOrder refuses a non-paid order). */
async function makePaidOrder(variantId: string, currency: string): Promise<string> {
  const cartId = await makeReadyCart(variantId, currency);
  const order = await h.orders.createFromCart(T, cartId, {});
  await h.client`update orders set status = 'paid' where tenant_id = ${T} and id = ${order.id}`;
  return order.id;
}

describe('Invoice rollback leaves no gap', () => {
  it('an issuance that fails after reading the number does NOT consume it; next issuance reuses it', async () => {
    const { variantId, currency } = await seedVariant(h, { stock: 50, priceAmount: 1000 });
    await seedShippingRate(currency);

    const failOrderId = await makePaidOrder(variantId, currency);
    const okOrderId = await makePaidOrder(variantId, currency);

    // Force the INSERT to throw ONCE — AFTER allocateGaplessNumber has read+incremented the
    // counter inside the tx. The tx rolls back, so the increment rolls back with it.
    const real = repo.insertInvoice.bind(repo);
    const spy = jest
      .spyOn(repo, 'insertInvoice')
      .mockImplementationOnce(async () => {
        throw new Error('induced issuance failure after number read');
      })
      .mockImplementation((tx, values) => real(tx, values));

    await expect(invoices.issueForOrder(T, failOrderId)).rejects.toThrow(
      /induced issuance failure/,
    );

    // The failed order has NO invoice.
    const failCount = await h.client<{ n: number }[]>`
      select count(*)::int as n from invoices where order_id = ${failOrderId}
    `;
    expect(failCount[0]!.n).toBe(0);

    // The counter was NOT advanced by the rolled-back attempt. Because the counter ROW was
    // first created inside that same (rolled-back) tx, the row itself rolled back too — so it
    // is either absent (→ next issuance starts at 1) or, if it pre-existed, still at 1. Either
    // way NO number was consumed.
    const counterAfterFail = await h.client<{ next_value: string }[]>`
      select next_value from invoice_counters where tenant_id = ${T} and series = 'STD'
    `;
    if (counterAfterFail.length > 0) {
      expect(Number(counterAfterFail[0]!.next_value)).toBe(1);
    } else {
      expect(counterAfterFail).toHaveLength(0); // row creation rolled back with the failed tx
    }

    // The NEXT successful issuance REUSES the un-consumed number → 000001 (no gap).
    const ok = await invoices.issueForOrder(T, okOrderId);
    expect(ok.created).toBe(true);
    expect(ok.invoice.invoiceNumber).toMatch(/^\d{4}-000001$/);
    expect(spy).toHaveBeenCalled();

    // Exactly one invoice exists, numbered 000001 — the failed attempt burned nothing.
    const all = await h.client<{ invoice_number: string }[]>`
      select invoice_number from invoices where tenant_id = ${T} and type = 'invoice'
    `;
    expect(all).toHaveLength(1);
    expect(all[0]!.invoice_number).toMatch(/^\d{4}-000001$/);
  });
});

describe('Concurrent same-order double-issue', () => {
  it('two simultaneous issueForOrder for ONE order → exactly one invoice; counter advances by 1', async () => {
    const { variantId, currency } = await seedVariant(h, { stock: 50, priceAmount: 1000 });
    await seedShippingRate(currency);
    const orderId = await makePaidOrder(variantId, currency);

    // Fire TWO issuances for the SAME order simultaneously (shared-promise barrier).
    const { fulfilled, rejected } = await runConcurrently(
      2,
      () => invoices.issueForOrder(T, orderId),
      'same-order double-issue',
    );

    // Neither throws (the loser resolves to the winner's invoice via the in-tx re-check /
    // partial-unique-index catch), and both observe the SAME invoice id.
    expect(rejected).toHaveLength(0);
    expect(fulfilled).toHaveLength(2);
    const ids = new Set(fulfilled.map((r) => r.value.invoice.id));
    expect(ids.size).toBe(1);
    // Exactly one of the two reports created=true (the winner); the loser is created=false.
    const createdFlags = fulfilled.map((r) => r.value.created).sort();
    expect(createdFlags).toEqual([false, true]);

    // EXACTLY ONE invoice persisted for the order.
    const count = await h.client<{ n: number }[]>`
      select count(*)::int as n from invoices where order_id = ${orderId} and type = 'invoice'
    `;
    expect(count[0]!.n).toBe(1);

    // The counter advanced by EXACTLY 1 (the loser consumed NO number) → next_value 2.
    const counter = await h.client<{ next_value: string }[]>`
      select next_value from invoice_counters where tenant_id = ${T} and series = 'STD'
    `;
    expect(Number(counter[0]!.next_value)).toBe(2);
  });
});
