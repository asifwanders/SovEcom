/**
 * Stripe payments integration tests. Full AppModule against real
 * Postgres + Redis, with the Stripe client mocked (no live keys). Covers the money/security
 * invariants that only a real DB proves:
 *   - payment-intent: server amount, idempotent load-or-create, velocity cap;
 *   - webhook: signature reject, succeeded → paid → invoice (once), replay idempotency;
 *   - dispute → fulfillment freeze blocks shipping;
 *   - stale-unpaid sweeper cancels + restocks.
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
import { truncateWithRetry } from '../cart/_cart-harness';

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
  // payment_events has no FK to orders, so the order-cascade truncate misses it — clear it (and
  // disputes) explicitly. Deadlock-retry: a fire-and-forget post-commit op may hold locks.
  await truncateWithRetry(h, 'TRUNCATE TABLE payment_events, disputes RESTART IDENTITY CASCADE');
  await h.redis.flushdb(); // isolate rate-limit counters between tests
  resetStripeMock();
}, 15_000);

async function stockOf(variantId: string): Promise<number> {
  const rows = await h.client<{ stock_quantity: number }[]>`
    select stock_quantity from product_variants where id = ${variantId}`;
  return rows[0]!.stock_quantity;
}
async function orderStatus(orderId: string): Promise<string> {
  const rows = await h.client<
    { status: string }[]
  >`select status from orders where id = ${orderId}`;
  return rows[0]!.status;
}

function succeededEvent(orderId: string, piId = 'pi_test', evtId = 'evt_succ') {
  return {
    id: evtId,
    type: 'payment_intent.succeeded',
    data: {
      object: { id: piId, status: 'succeeded', metadata: { orderId, tenantId: DEFAULT_TENANT_ID } },
    },
  };
}

describe('POST /store/v1/carts/:cartId/payment-intent', () => {
  it('creates the order + a Stripe intent for the SERVER total, keyed on the order id', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 2);

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/payment-intent`)
      .set('Cookie', cartCookie)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'requires_payment',
      clientSecret: 'cs_test_secret',
      orderId: expect.any(String),
    });
    // amount = subtotal(2000) + shipping(500) + tax(0). Never a client-supplied value.
    expect(res.body.amount).toBe(2500);
    const createArg = stripeMock.paymentIntents.create.mock.calls[0][0];
    expect(createArg.amount).toBe(2500);
    expect(createArg.metadata).toMatchObject({ orderId: res.body.orderId });
    expect(stripeMock.paymentIntents.create.mock.calls[0][1]).toEqual({
      idempotencyKey: res.body.orderId,
    });

    // A payments row was persisted (pending) and the order is awaiting payment.
    const pay = await h.client`select * from payments where order_id = ${res.body.orderId}`;
    expect(pay.length).toBe(1);
    expect(await orderStatus(res.body.orderId)).toBe('pending_payment');
  });

  it('is idempotent on a converted cart (double-submit → same order)', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 1);

    const a = await request(h.http())
      .post(`/store/v1/carts/${cartId}/payment-intent`)
      .set('Cookie', cartCookie)
      .send({});
    const b = await request(h.http())
      .post(`/store/v1/carts/${cartId}/payment-intent`)
      .set('Cookie', cartCookie)
      .send({});

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.orderId).toBe(a.body.orderId);
    const orders = await h.client`select id from orders where cart_id = ${cartId}`;
    expect(orders.length).toBe(1); // exactly one order for the cart
  });

  it('enforces the per-cart velocity cap (card-testing defence)', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 100 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 1);

    let saw429 = false;
    for (let i = 0; i < 13; i++) {
      const r = await request(h.http())
        .post(`/store/v1/carts/${cartId}/payment-intent`)
        .set('Cookie', cartCookie)
        .send({});
      if (r.status === 429) saw429 = true;
    }
    expect(saw429).toBe(true);
  });
});

describe('POST /webhooks/stripe', () => {
  async function placeOrder(): Promise<{ orderId: string; variantId: string }> {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 1);
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});
    return { orderId: res.body.id as string, variantId };
  }

  it('rejects a bad signature with 400 and does not touch the order', async () => {
    const { orderId } = await placeOrder();
    stripeMock.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found');
    });
    const res = await request(h.http())
      .post('/webhooks/stripe')
      .set('stripe-signature', 'bad')
      .send({ any: 'body' });
    expect(res.status).toBe(400);
    expect(await orderStatus(orderId)).toBe('pending_payment');
  });

  it('payment_intent.succeeded drives the order → paid and issues exactly one invoice', async () => {
    const { orderId } = await placeOrder();
    stripeMock.webhooks.constructEvent.mockReturnValue(succeededEvent(orderId));

    const res = await request(h.http())
      .post('/webhooks/stripe')
      .set('stripe-signature', 'ok')
      .send({});
    expect(res.status).toBe(200);
    expect(await orderStatus(orderId)).toBe('paid');

    const pay = await h.client<{ status: string }[]>`
      select status from payments where order_id = ${orderId}`;
    expect(pay[0]!.status).toBe('succeeded');

    const invoice = await waitForInvoice(h, orderId);
    expect(invoice).not.toBeNull();
  });

  it('is idempotent: a replayed event marks paid once and issues one invoice', async () => {
    const { orderId } = await placeOrder();
    stripeMock.webhooks.constructEvent.mockReturnValue(
      succeededEvent(orderId, 'pi_dup', 'evt_dup'),
    );

    await request(h.http()).post('/webhooks/stripe').set('stripe-signature', 'ok').send({});
    await waitForInvoice(h, orderId);
    // Replay the SAME event id.
    const second = await request(h.http())
      .post('/webhooks/stripe')
      .set('stripe-signature', 'ok')
      .send({});
    expect(second.status).toBe(200);

    const events = await h.client`select 1 from payment_events where event_id = ${'evt_dup'}`;
    expect(events.length).toBe(1); // claimed once
    const invoices =
      await h.client`select 1 from invoices where order_id = ${orderId} and type = 'invoice'`;
    expect(invoices.length).toBe(1); // issued once
  });

  it('charge.dispute.created freezes fulfillment so the order cannot ship', async () => {
    const { orderId } = await placeOrder();
    // First pay it (so a payment row exists for the dispute to link to).
    stripeMock.webhooks.constructEvent.mockReturnValue(succeededEvent(orderId, 'pi_disp', 'evt_p'));
    await request(h.http()).post('/webhooks/stripe').set('stripe-signature', 'ok').send({});
    expect(await orderStatus(orderId)).toBe('paid');

    // Now a dispute opens on that payment intent.
    stripeMock.webhooks.constructEvent.mockReturnValue({
      id: 'evt_disp',
      type: 'charge.dispute.created',
      data: {
        object: {
          id: 'dp_1',
          amount: 1500,
          currency: 'eur',
          reason: 'fraudulent',
          status: 'needs_response',
          payment_intent: 'pi_disp',
          evidence_details: { due_by: 1_900_000_000 },
        },
      },
    });
    await request(h.http()).post('/webhooks/stripe').set('stripe-signature', 'ok').send({});

    const frozen = await h.client<{ fulfillment_frozen: boolean }[]>`
      select fulfillment_frozen from orders where id = ${orderId}`;
    expect(frozen[0]!.fulfillment_frozen).toBe(true);

    // The admin cannot advance a frozen order to fulfilled.
    const admin = await seedAdminAndLogin(h, 'admin');
    const res = await request(h.http())
      .post(`/admin/v1/orders/${orderId}/transitions`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ to: 'fulfilled' });
    expect(res.status).toBe(422);
    expect(await orderStatus(orderId)).toBe('paid');

    // A dispute row was recorded.
    const disputes = await h.client`select 1 from disputes where provider_dispute_id = ${'dp_1'}`;
    expect(disputes.length).toBe(1);
  });
});

describe('manual/offline payment recording', () => {
  async function placeOrder(qty = 1): Promise<string> {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, qty);
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});
    return res.body.id as string;
  }

  it('POST /orders/:id/payments records a manual payment row and drives → paid', async () => {
    const orderId = await placeOrder(2); // total 2000 + 500 shipping = 2500
    const admin = await seedAdminAndLogin(h, 'admin');
    const res = await request(h.http())
      .post(`/admin/v1/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ method: 'bank_transfer' })
      .expect(200);

    expect(res.body).toMatchObject({ orderId, status: 'paid', method: 'bank_transfer' });
    expect(await orderStatus(orderId)).toBe('paid');
    const pay = await h.client<
      { provider: string; method: string; status: string; amount: number }[]
    >`
      select provider, method, status, amount from payments where order_id = ${orderId}`;
    expect(pay).toHaveLength(1);
    expect(pay[0]).toMatchObject({
      provider: 'manual',
      method: 'bank_transfer',
      status: 'succeeded',
      amount: 2500,
    });
  });

  it('mark-paid alias records a full-amount manual payment + issues the invoice', async () => {
    const orderId = await placeOrder(1); // 1000 + 500 = 1500
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/mark-paid`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const pay = await h.client<{ provider: string; amount: number }[]>`
      select provider, amount from payments where order_id = ${orderId}`;
    expect(pay[0]).toMatchObject({ provider: 'manual', amount: 1500 });
    const invoice = await waitForInvoice(h, orderId);
    expect(invoice).not.toBeNull();
  });

  it('refuses a manual payment when a SEPA is already in-flight (Fable B3 — no double collection)', async () => {
    const orderId = await placeOrder(1);
    // SEPA accepted → processing payment row, order still pending_payment.
    stripeMock.webhooks.constructEvent.mockReturnValue({
      id: 'evt_proc_b3',
      type: 'payment_intent.processing',
      data: {
        object: {
          id: 'pi_b3',
          status: 'processing',
          metadata: { orderId, tenantId: DEFAULT_TENANT_ID },
        },
      },
    });
    await request(h.http()).post('/webhooks/stripe').set('stripe-signature', 'ok').send({});

    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ method: 'bank_transfer' })
      .expect(409);
    expect(await orderStatus(orderId)).toBe('pending_payment'); // not flipped to paid
  });

  it('rejects an amount ≠ the order total (Fable B4)', async () => {
    const orderId = await placeOrder(2); // total 2500
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ method: 'cash', amount: 999 })
      .expect(422);
    expect(await orderStatus(orderId)).toBe('pending_payment'); // never paid
  });

  it('409s when the order is no longer pending_payment (no second payment row)', async () => {
    const orderId = await placeOrder(1);
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/mark-paid`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    // Second attempt — order is already paid.
    await request(h.http())
      .post(`/admin/v1/orders/${orderId}/payments`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ method: 'cash' })
      .expect(409);
    const pay = await h.client`select 1 from payments where order_id = ${orderId}`;
    expect(pay).toHaveLength(1); // only the first
  });
});

describe('stale-unpaid-order sweeper', () => {
  it('cancels an aged pending_payment order and restocks its consumed stock', async () => {
    const { StaleOrderSweeperService } =
      await import('../../../src/orders/stale-order-sweeper.service');
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 3);
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});
    const orderId = res.body.id as string;
    expect(await stockOf(variantId)).toBe(7); // 10 − 3 consumed at creation

    // Backdate the order beyond any TTL and sweep.
    await h.client`update orders set created_at = now() - interval '2 days' where id = ${orderId}`;
    const sweeper = h.app.get(StaleOrderSweeperService);
    const cancelled = await sweeper.sweep();

    expect(cancelled).toBeGreaterThanOrEqual(1);
    expect(await orderStatus(orderId)).toBe('cancelled');
    // Restock listener restored the 3 units (fire-and-forget → poll).
    const deadline = Date.now() + 3000;
    let restored = await stockOf(variantId);
    while (restored !== 10 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      restored = await stockOf(variantId);
    }
    expect(restored).toBe(10);
  });

  it('does NOT cancel an aged order with an in-flight (processing) SEPA payment', async () => {
    const { StaleOrderSweeperService } =
      await import('../../../src/orders/stale-order-sweeper.service');
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 2);
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});
    const orderId = res.body.id as string;

    // SEPA accepted but clearing → payment row 'processing', order stays pending_payment.
    stripeMock.webhooks.constructEvent.mockReturnValue({
      id: 'evt_proc',
      type: 'payment_intent.processing',
      data: {
        object: {
          id: 'pi_sepa',
          status: 'processing',
          metadata: { orderId, tenantId: DEFAULT_TENANT_ID },
        },
      },
    });
    await request(h.http()).post('/webhooks/stripe').set('stripe-signature', 'ok').send({});
    expect(await orderStatus(orderId)).toBe('pending_payment');

    // Backdate well past the TTL and sweep — the in-flight SEPA order must be SPARED.
    await h.client`update orders set created_at = now() - interval '2 days' where id = ${orderId}`;
    const sweeper = h.app.get(StaleOrderSweeperService);
    await sweeper.sweep();

    expect(await orderStatus(orderId)).toBe('pending_payment'); // not cancelled
    expect(await stockOf(variantId)).toBe(8); // stock still consumed (not restocked)

    // If that SEPA later FAILS, the order becomes sweepable again.
    stripeMock.webhooks.constructEvent.mockReturnValue({
      id: 'evt_fail',
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_sepa',
          status: 'requires_payment_method',
          metadata: { orderId, tenantId: DEFAULT_TENANT_ID },
        },
      },
    });
    await request(h.http()).post('/webhooks/stripe').set('stripe-signature', 'ok').send({});
    await sweeper.sweep();
    expect(await orderStatus(orderId)).toBe('cancelled');
  });
});
