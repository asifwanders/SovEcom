/**
 * Return-approve race: a return approved by TWO concurrent/
 * retried requests must issue EXACTLY ONE refund. The status CAS (`requested → approved`) is the
 * serialization point; the loser 409s before touching the gateway. Exercises the partial/line case
 * (qty < remaining) — the one the 2.11 total/per-line guards alone do NOT make idempotent.
 */
import { ConflictException } from '@nestjs/common';
import {
  bootConcurrencyApp,
  teardownConcurrencyApp,
  resetConcurrencyState,
  runConcurrently,
  newId,
  DEFAULT_TENANT_ID,
  type ConcurrencyHarness,
} from './harness';
import { ReturnsService } from '../../src/returns/returns.service';

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

/** Seed a paid order (qty-3 line, total 3000), a manual payment, and a `requested` return of 1 unit. */
async function seedRequestedReturn(): Promise<string> {
  const orderId = newId();
  const itemId = newId();
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
    values (${orderId}, ${T}, ${`RA-${orderId.slice(0, 8)}`}, ${'b@t.invalid'}, ${'paid'}, ${'EUR'},
      ${3000}, ${3000}, ${0}, ${false}, ${addr}::jsonb, ${addr}::jsonb)`;
  await h.client`
    insert into order_items (id, tenant_id, order_id, product_title, sku, quantity,
      unit_price_amount, tax_rate, tax_amount, line_total_amount)
    values (${itemId}, ${T}, ${orderId}, ${'Item'}, ${'SKU'}, ${3}, ${1000}, ${'0.0000'}, ${0}, ${3000})`;
  await h.client`
    insert into payments (id, tenant_id, order_id, provider, amount, currency, status)
    values (${newId()}, ${T}, ${orderId}, ${'manual'}, ${3000}, ${'EUR'}, ${'succeeded'})`;
  const returnId = newId();
  await h.client`
    insert into returns (id, tenant_id, order_id, type, status, items, within_withdrawal_window, requested_at)
    values (${returnId}, ${T}, ${orderId}, ${'return'}, ${'requested'},
      ${JSON.stringify([{ orderItemId: itemId, quantity: 1 }])}::jsonb, ${true}, now())`;
  return returnId;
}

describe('Return approve race', () => {
  it('two concurrent approves of one partial return issue EXACTLY one refund', async () => {
    const returnId = await seedRequestedReturn();
    const svc = h.app.get(ReturnsService);

    const { fulfilled, rejected } = await runConcurrently(2, () => svc.approve(T, returnId, null));

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictException);

    const [{ orderId }] = await h.client<{ orderId: string }[]>`
      select order_id as "orderId" from returns where id = ${returnId}`;
    const refunds = await h.client`select 1 from refunds where order_id = ${orderId}`;
    expect(refunds).toHaveLength(1); // exactly one refund, not two
    const [order] = await h.client<{ refunded_amount: number; status: string }[]>`
      select refunded_amount, status from orders where id = ${orderId}`;
    expect(order!.refunded_amount).toBe(1000); // one unit only
    expect(order!.status).toBe('partially_refunded');
    const [ret] = await h.client<
      { status: string }[]
    >`select status from returns where id = ${returnId}`;
    expect(ret!.status).toBe('refunded');
  });
});
