/**
 * Refund race: concurrent refunds against ONE order must NEVER
 * exceed the captured amount. The order `FOR UPDATE` lock in RefundService.create serialises the
 * attempts; each re-checks `remaining = total − refunded_amount` under the lock, so the losers 422
 * once the balance is exhausted. Invariants after the race:
 *   - `orders.refunded_amount` ≤ `total_amount` (no over-refund);
 *   - Σ recorded refund amounts == `refunded_amount` (consistent);
 *   - exactly ⌊total/each⌋ succeed, the rest reject (UnprocessableEntity).
 */
import { UnprocessableEntityException } from '@nestjs/common';
import {
  bootConcurrencyApp,
  teardownConcurrencyApp,
  resetConcurrencyState,
  runConcurrently,
  newId,
  DEFAULT_TENANT_ID,
  type ConcurrencyHarness,
} from './harness';
import { RefundService } from '../../src/payments/refunds/refund.service';

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

/** Seed a paid order (total 1000) with one line + a manual succeeded payment. Returns the id. */
async function seedPaidOrder(): Promise<string> {
  const orderId = newId();
  const addr = JSON.stringify({
    name: 'B',
    line1: '1 st',
    city: 'C',
    postalCode: '1',
    country: 'FR',
  });
  await h.client`
    insert into orders (id, tenant_id, order_number, email, status, currency, subtotal_amount,
      total_amount, tax_amount, tax_inclusive, shipping_address, billing_address)
    values (${orderId}, ${T}, ${`R-${orderId.slice(0, 8)}`}, ${'b@t.invalid'}, ${'paid'}, ${'EUR'},
      ${1000}, ${1000}, ${0}, ${false}, ${addr}::jsonb, ${addr}::jsonb)`;
  await h.client`
    insert into order_items (id, tenant_id, order_id, product_title, sku, quantity,
      unit_price_amount, tax_rate, tax_amount, line_total_amount)
    values (${newId()}, ${T}, ${orderId}, ${'Item'}, ${'SKU'}, ${1}, ${1000}, ${'0.0000'}, ${0}, ${1000})`;
  await h.client`
    insert into payments (id, tenant_id, order_id, provider, amount, currency, status)
    values (${newId()}, ${T}, ${orderId}, ${'manual'}, ${1000}, ${'EUR'}, ${'succeeded'})`;
  return orderId;
}

describe('Refund race', () => {
  it('concurrent partial refunds never exceed the captured amount', async () => {
    const orderId = await seedPaidOrder();
    const refundService = h.app.get(RefundService);

    // 5 simultaneous refunds of 300 against a 1000 order → at most 3 can succeed (900 ≤ 1000).
    const { fulfilled, rejected } = await runConcurrently(5, () =>
      refundService.create(T, orderId, { amount: 300, actorUserId: null }),
    );

    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(UnprocessableEntityException);

    const [order] = await h.client<{ refunded_amount: number; total_amount: number }[]>`
      select refunded_amount, total_amount from orders where id = ${orderId}`;
    expect(order!.refunded_amount).toBe(900);
    expect(order!.refunded_amount).toBeLessThanOrEqual(order!.total_amount); // NEVER over-refund

    const [sum] = await h.client<{ total: number }[]>`
      select coalesce(sum(amount),0)::int as total from refunds where order_id = ${orderId}`;
    expect(sum!.total).toBe(900); // Σ refunds == refunded_amount (consistent)
  });
});
