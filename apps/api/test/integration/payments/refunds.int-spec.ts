/**
 * Refunds & credit notes integration. Full AppModule, real Postgres,
 * mocked Stripe. Covers full / line+restock / partial-amount refunds, over-refund guard, the
 * Stripe-vs-manual branch, the gapless immutable credit note, and tax reversal (eu_vat).
 */
import request from 'supertest';
import {
  bootPaymentsApp,
  resetOrderState,
  resetStripeMock,
  stripeMock,
  seedSimpleProduct,
  driveCartToCheckoutReady,
  seedAdminAndLogin,
  waitForInvoice,
  DEFAULT_TENANT_ID,
  type PaymentsHarness,
} from './_payments-harness';
import { seedTaxRate, setTaxSettings, truncateWithRetry } from '../cart/_cart-harness';

let h: PaymentsHarness;
/** Monotonic suffix so each admin refund POST carries a DISTINCT stable idempotencyKey. */
let idemSeq = 0;

beforeAll(async () => {
  h = await bootPaymentsApp();
}, 30_000);
afterAll(async () => {
  await h.app.close();
  await h.client.end();
});
beforeEach(async () => {
  await resetOrderState(h);
  await truncateWithRetry(h, 'TRUNCATE TABLE payment_events, disputes RESTART IDENTITY CASCADE');
  await h.redis.flushdb();
  resetStripeMock();
});

async function row<T>(sql: ReturnType<PaymentsHarness['client']>): Promise<T> {
  return (await sql)[0] as T;
}
async function orderRow(orderId: string) {
  return row<{ status: string; refunded_amount: number; total_amount: number }>(
    h.client`select status, refunded_amount, total_amount from orders where id = ${orderId}`,
  );
}
async function stockOf(variantId: string): Promise<number> {
  return (
    await h.client<{ stock_quantity: number }[]>`
      select stock_quantity from product_variants where id = ${variantId}`
  )[0]!.stock_quantity;
}

/** Place an order, pay it via a Stripe-succeeded webhook, and return ids. */
async function paidStripeOrder(qty = 3, price = 1000) {
  const { variantId } = await seedSimpleProduct(h, { price, stock: 10 });
  const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, qty);
  const co = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cartCookie)
    .send({});
  const orderId = co.body.id as string;
  stripeMock.webhooks.constructEvent.mockReturnValue({
    id: `evt_${orderId}`,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: `pi_${orderId}`,
        status: 'succeeded',
        metadata: { orderId, tenantId: DEFAULT_TENANT_ID },
      },
    },
  });
  await request(h.http()).post('/webhooks/stripe').set('stripe-signature', 'ok').send({});
  return { orderId, variantId, total: co.body.totalAmount as number };
}

describe('POST /admin/v1/orders/:id/refunds — full refund (Stripe)', () => {
  it('refunds the whole order, issues a gapless credit note, leaves the original invoice untouched', async () => {
    const { orderId, total } = await paidStripeOrder();
    await waitForInvoice(h, orderId); // the order.paid invoice issues fire-and-forget
    const original = await row<{ invoice_number: string; total_amount: number }>(
      h.client`select invoice_number, total_amount from invoices where order_id = ${orderId} and type='invoice'`,
    );
    const admin = await seedAdminAndLogin(h, 'admin');

    const res = await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(201);
    expect(res.body).toMatchObject({ amount: total, status: 'succeeded', orderStatus: 'refunded' });

    // Stripe refund called for the full amount.
    expect(stripeMock.refunds.create.mock.calls[0][0]).toMatchObject({ amount: total });

    const o = await orderRow(orderId);
    expect(o.status).toBe('refunded');
    expect(o.refunded_amount).toBe(total);

    // A credit note in the CN series, correcting the original; original invoice unchanged.
    const cn = await row<{
      series: string;
      total_amount: number;
      corrects_invoice_id: string | null;
    }>(
      h.client`select series, total_amount, corrects_invoice_id from invoices where order_id = ${orderId} and type='credit_note'`,
    );
    expect(cn.series).toBe('CN');
    expect(cn.total_amount).toBe(total);
    expect(cn.corrects_invoice_id).not.toBeNull();
    const after = await row<{ invoice_number: string; total_amount: number }>(
      h.client`select invoice_number, total_amount from invoices where order_id = ${orderId} and type='invoice'`,
    );
    expect(after).toEqual(original); // original invoice immutable
  });

  it('refuses a second refund once fully refunded (422)', async () => {
    const { orderId } = await paidStripeOrder();
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(201);
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(422);
  });
});

// ── A stable idempotencyKey is REQUIRED so a committed-retry can't double-refund ──
describe('idempotencyKey is required', () => {
  it('rejects a refund POST with no idempotencyKey (400) — no Stripe refund created', async () => {
    const { orderId } = await paidStripeOrder(1, 1000);
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({})
      .expect(400);
    expect(stripeMock.refunds.create).not.toHaveBeenCalled();
    expect((await orderRow(orderId)).status).toBe('paid'); // untouched
  });

  it('two DISTINCT partial refunds with DISTINCT keys both succeed', async () => {
    const { orderId } = await paidStripeOrder(3, 1000); // total 3500
    const admin = await seedAdminAndLogin(h, 'admin');
    stripeMock.refunds.create.mockResolvedValueOnce({ id: 're_a', status: 'succeeded' });
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ amount: 500, idempotencyKey: `${orderId}:a` })
      .expect(201);
    stripeMock.refunds.create.mockResolvedValueOnce({ id: 're_b', status: 'succeeded' });
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ amount: 500, idempotencyKey: `${orderId}:b` })
      .expect(201);

    // Both went through (distinct keys → distinct Stripe refunds → distinct provider_refund_id rows).
    expect((await orderRow(orderId)).refunded_amount).toBe(1000);
    const refunds = await h.client`select 1 from refunds where order_id = ${orderId}`;
    expect(refunds).toHaveLength(2);
    // The key was forwarded verbatim to Stripe (the 2nd arg — request options) → stable on retry.
    expect(stripeMock.refunds.create.mock.calls.map((c) => c[1].idempotencyKey)).toEqual([
      `${orderId}:a`,
      `${orderId}:b`,
    ]);
  });
});

describe('line + partial-amount refunds', () => {
  it('line refund with restock → partially_refunded, stock restored, refund_line_items recorded', async () => {
    const { orderId, variantId } = await paidStripeOrder(3, 1000); // subtotal 3000 + 500 ship = 3500
    const stockBefore = await stockOf(variantId);
    const item = await row<{ id: string; quantity: number; line_total_amount: number }>(
      h.client`select id, quantity, line_total_amount from order_items where order_id = ${orderId} limit 1`,
    );
    const admin = await seedAdminAndLogin(h, 'admin');

    const res = await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        items: [{ orderItemId: item.id, quantity: 1, restock: true }],
        idempotencyKey: `idem-${orderId}-${idemSeq++}`,
      })
      .expect(201);
    expect(res.body.orderStatus).toBe('partially_refunded');

    const o = await orderRow(orderId);
    expect(o.status).toBe('partially_refunded');
    expect(o.refunded_amount).toBe(Math.round((item.line_total_amount * 1) / item.quantity)); // 1 of 3
    expect(await stockOf(variantId)).toBe(stockBefore + 1);
    const rli = await h.client`select 1 from refund_line_items where order_item_id = ${item.id}`;
    expect(rli).toHaveLength(1);
  });

  it('partial-amount refund → partially_refunded, refunded_amount tracks the amount', async () => {
    const { orderId } = await paidStripeOrder(3, 1000);
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ amount: 500, idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(201);
    const o = await orderRow(orderId);
    expect(o.refunded_amount).toBe(500);
    expect(o.status).toBe('partially_refunded');
  });

  it('rejects an amount over the remaining (422)', async () => {
    const { orderId, total } = await paidStripeOrder(1, 1000);
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ amount: total + 1, idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(422);
    expect((await orderRow(orderId)).status).toBe('paid'); // unchanged
  });
});

describe('manual payment → offline refund (no gateway call)', () => {
  it('refunds without calling Stripe and still issues a credit note', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 1);
    const co = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});
    const orderId = co.body.id as string;
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/mark-paid`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(201);

    expect(stripeMock.refunds.create).not.toHaveBeenCalled(); // offline
    const cn =
      await h.client`select 1 from invoices where order_id = ${orderId} and type='credit_note'`;
    expect(cn).toHaveLength(1);
    expect((await orderRow(orderId)).status).toBe('refunded');
  });
});

describe('refund.created — dashboard-initiated reconciliation', () => {
  function chargeRefundedEvent(orderId: string, refundId: string, amount: number) {
    // The PRIMARY modern-API path: refund.created carries the Refund object directly.
    stripeMock.webhooks.constructEvent.mockReturnValue({
      id: `evt_rc_${refundId}`,
      type: 'refund.created',
      data: {
        object: { id: refundId, payment_intent: `pi_${orderId}`, amount, status: 'succeeded' },
      },
    });
  }

  it('records a dashboard refund (refund row + credit note + state) we did not initiate', async () => {
    const { orderId, total } = await paidStripeOrder(1, 1000);
    chargeRefundedEvent(orderId, 're_dash', total);
    await request(h.http())
      .post('/webhooks/stripe')
      .set('stripe-signature', 'ok')
      .send({})
      .expect(200);

    const refund = await row<{ provider_refund_id: string; amount: number }>(
      h.client`select provider_refund_id, amount from refunds where order_id = ${orderId}`,
    );
    expect(refund).toMatchObject({ provider_refund_id: 're_dash', amount: total });
    const cn =
      await h.client`select 1 from invoices where order_id = ${orderId} and type='credit_note'`;
    expect(cn).toHaveLength(1);
    expect((await orderRow(orderId)).status).toBe('refunded');
  });

  it('is idempotent: an admin refund + its echoing charge.refunded record ONE refund', async () => {
    const { orderId, total } = await paidStripeOrder(1, 1000);
    const admin = await seedAdminAndLogin(h, 'admin');
    // Admin-initiated full refund — the mocked Stripe refund id:
    stripeMock.refunds.create.mockResolvedValue({ id: 're_admin', status: 'succeeded' });
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(201);

    // Stripe now echoes the SAME refund id via charge.refunded.
    chargeRefundedEvent(orderId, 're_admin', total);
    await request(h.http())
      .post('/webhooks/stripe')
      .set('stripe-signature', 'ok')
      .send({})
      .expect(200);

    const refunds = await h.client`select 1 from refunds where order_id = ${orderId}`;
    expect(refunds).toHaveLength(1); // not doubled
    const cns =
      await h.client`select 1 from invoices where order_id = ${orderId} and type='credit_note'`;
    expect(cns).toHaveLength(1);
  });
});

// ── Async (SEPA) refund: defer fiscal side-effects until CONFIRMED, back out on failure ──
describe('async (pending) refund — defer + back-out', () => {
  function refundUpdatedEvent(orderId: string, refundId: string, amount: number, status: string) {
    stripeMock.webhooks.constructEvent.mockReturnValue({
      id: `evt_ru_${refundId}_${status}`,
      type: 'refund.updated',
      data: { object: { id: refundId, payment_intent: `pi_${orderId}`, amount, status } },
    });
  }
  async function fireWebhook() {
    await request(h.http()).post('/webhooks/stripe').set('stripe-signature', 'ok').send({}).expect(200); // prettier-ignore
  }
  async function countCreditNotes(orderId: string): Promise<number> {
    return (
      await h.client`select 1 from invoices where order_id = ${orderId} and type='credit_note'`
    ).length;
  }

  it('PENDING async refund reserves refunded_amount but issues NO credit note and does NOT drive the order', async () => {
    const { orderId, total } = await paidStripeOrder(1, 1000);
    await waitForInvoice(h, orderId);
    const admin = await seedAdminAndLogin(h, 'admin');
    stripeMock.refunds.create.mockResolvedValue({ id: 're_sepa', status: 'pending' });

    const res = await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(201);
    expect(res.body.status).toBe('pending');

    const o = await orderRow(orderId);
    expect(o.refunded_amount).toBe(total); // reserved → the over-refund guard still holds
    expect(o.status).toBe('paid'); // NOT driven to refunded until confirmed
    expect(await countCreditNotes(orderId)).toBe(0); // no irreversible fiscal doc yet

    // The reservation blocks a second over-refund.
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(422);
  });

  it('PENDING → FAILED backs out: refund failed, refunded_amount restored, no credit note, order back to paid', async () => {
    const { orderId, total } = await paidStripeOrder(1, 1000);
    await waitForInvoice(h, orderId);
    const admin = await seedAdminAndLogin(h, 'admin');
    stripeMock.refunds.create.mockResolvedValue({ id: 're_sepa', status: 'pending' });
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(201);

    // The bank rejects later.
    refundUpdatedEvent(orderId, 're_sepa', total, 'failed');
    await fireWebhook();

    const refund = await row<{ status: string }>(
      h.client`select status from refunds where order_id = ${orderId}`,
    );
    expect(refund.status).toBe('failed');
    const o = await orderRow(orderId);
    expect(o.refunded_amount).toBe(0); // backed out
    expect(o.status).toBe('paid'); // restored
    expect(await countCreditNotes(orderId)).toBe(0); // no standing CN for un-returned money

    // With the reservation released a fresh full refund is allowed again.
    stripeMock.refunds.create.mockResolvedValue({ id: 're_retry', status: 'succeeded' });
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(201);
    expect((await orderRow(orderId)).status).toBe('refunded');
  });

  it('PENDING → SUCCEEDED applies all effects exactly once (credit note, order drive)', async () => {
    const { orderId, total } = await paidStripeOrder(1, 1000);
    await waitForInvoice(h, orderId);
    const admin = await seedAdminAndLogin(h, 'admin');
    stripeMock.refunds.create.mockResolvedValue({ id: 're_sepa', status: 'pending' });
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `idem-${orderId}-${idemSeq++}` })
      .expect(201);

    refundUpdatedEvent(orderId, 're_sepa', total, 'succeeded');
    await fireWebhook();

    const refund = await row<{ status: string }>(
      h.client`select status from refunds where order_id = ${orderId}`,
    );
    expect(refund.status).toBe('succeeded');
    const o = await orderRow(orderId);
    expect(o.refunded_amount).toBe(total);
    expect(o.status).toBe('refunded');
    expect(await countCreditNotes(orderId)).toBe(1); // issued exactly once on confirmation

    // A duplicate succeeded event is idempotent — no second credit note.
    refundUpdatedEvent(orderId, 're_sepa', total, 'succeeded');
    await fireWebhook();
    expect(await countCreditNotes(orderId)).toBe(1);
    expect((await orderRow(orderId)).refunded_amount).toBe(total);
  });
});

// ── Credit note must never be minted with empty {} seller/buyer when no original invoice ──
describe('credit note when the order has NO original invoice', () => {
  /** Drop the invoice (immutability trigger forbids DELETE) to simulate a swallowed issuance. */
  async function deleteInvoiceBypassingTrigger(orderId: string) {
    await h.client`ALTER TABLE invoices DISABLE TRIGGER invoices_immutability_trg`;
    await h.client`DELETE FROM invoices WHERE order_id = ${orderId} AND type = 'invoice'`;
    await h.client`ALTER TABLE invoices ENABLE TRIGGER invoices_immutability_trg`;
  }

  it('issues the missing original first, links it, and mints a credit note with REAL identity (not {})', async () => {
    const { orderId, total } = await paidStripeOrder(1, 1000);
    await waitForInvoice(h, orderId);
    await deleteInvoiceBypassingTrigger(orderId);
    // Sanity: there is now no original invoice.
    expect(
      await h.client`select 1 from invoices where order_id = ${orderId} and type='invoice'`,
    ).toHaveLength(0);

    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `refund-${orderId}-1` })
      .expect(201);

    // An original invoice was back-issued, and the credit note links it.
    const orig = await row<{ id: string }>(
      h.client`select id from invoices where order_id = ${orderId} and type='invoice'`,
    );
    expect(orig?.id).toBeTruthy();
    const cn = await row<{
      seller_snapshot: Record<string, unknown>;
      buyer_snapshot: Record<string, unknown>;
      corrects_invoice_id: string | null;
      total_amount: number;
    }>(
      h.client`select seller_snapshot, buyer_snapshot, corrects_invoice_id, total_amount
               from invoices where order_id = ${orderId} and type='credit_note'`,
    );
    expect(cn.total_amount).toBe(total);
    expect(cn.corrects_invoice_id).toBe(orig.id); // linked to the (back-issued) original
    // The fiscal identity is populated — NOT the empty {} the bug minted.
    expect(Object.keys(cn.seller_snapshot).length).toBeGreaterThan(0);
    expect(Object.keys(cn.buyer_snapshot).length).toBeGreaterThan(0);
    expect(cn.buyer_snapshot.email).toBeTruthy();
    expect(cn.seller_snapshot.name).toBeTruthy();
  });
});

describe('eu_vat tax reversal', () => {
  it('TAX-INCLUSIVE line refund returns exactly the gross paid (Fable B1 — no VAT double-count)', async () => {
    await setTaxSettings(h, { taxMode: 'eu_vat', pricesIncludeTax: true, originCountry: 'FR' });
    await seedTaxRate(h, 'FR', 0.2);
    const { orderId } = await paidStripeOrder(2, 1200); // gross 1200/u incl 20% VAT
    const item = await row<{
      id: string;
      quantity: number;
      line_total_amount: number;
      tax_amount: number;
    }>(
      h.client`select id, quantity, line_total_amount, tax_amount from order_items where order_id = ${orderId} limit 1`,
    );
    const admin = await seedAdminAndLogin(h, 'admin');
    const res = await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        items: [{ orderItemId: item.id, quantity: 1 }],
        idempotencyKey: `idem-${orderId}-${idemSeq++}`,
      })
      .expect(201);

    // Refund for 1 of 2 units = exactly half the line's GROSS paid (line_total_amount is gross
    // in inclusive mode) — NOT gross+tax. Stripe is asked for that exact amount.
    const expectedGross = Math.round(item.line_total_amount / item.quantity);
    expect(res.body.amount).toBe(expectedGross);
    expect(stripeMock.refunds.create.mock.calls[0][0].amount).toBe(expectedGross);
  });

  it('a line refund reverses that line’s VAT onto the credit note', async () => {
    await setTaxSettings(h, { taxMode: 'eu_vat', pricesIncludeTax: false, originCountry: 'FR' });
    await seedTaxRate(h, 'FR', 0.2);
    const { orderId } = await paidStripeOrder(2, 1000); // 2×1000 net + 20% VAT
    const item = await row<{ id: string; quantity: number; tax_amount: number }>(
      h.client`select id, quantity, tax_amount from order_items where order_id = ${orderId} limit 1`,
    );
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        items: [{ orderItemId: item.id, quantity: 1 }],
        idempotencyKey: `idem-${orderId}-${idemSeq++}`,
      })
      .expect(201);

    const expectedLineTax = Math.round((item.tax_amount * 1) / item.quantity);
    const cn = await row<{ tax_amount: number }>(
      h.client`select tax_amount from invoices where order_id = ${orderId} and type='credit_note'`,
    );
    expect(cn.tax_amount).toBe(expectedLineTax);
    const refund = await row<{ tax_amount: number }>(
      h.client`select tax_amount from refunds where order_id = ${orderId}`,
    );
    expect(refund.tax_amount).toBe(expectedLineTax);
  });
});
