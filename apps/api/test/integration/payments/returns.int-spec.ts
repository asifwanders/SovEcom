/**
 * Returns & 14-day withdrawal integration. Full AppModule, real Postgres,
 * mocked Stripe. Covers request (own-order, window flag) → admin approve (2.11 refund + credit note
 * + restock) / reject, full vs partial refund, out-of-window flag, and IDOR.
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
import { signupAndLoginCustomer, truncateWithRetry } from '../cart/_cart-harness';

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
  await truncateWithRetry(h, 'TRUNCATE TABLE payment_events, disputes RESTART IDENTITY CASCADE');
  await h.redis.flushdb();
  resetStripeMock();
});

async function orderStatus(orderId: string): Promise<string> {
  const r = await h.client<{ status: string }[]>`select status from orders where id = ${orderId}`;
  return r[0]!.status;
}
async function stockOf(variantId: string): Promise<number> {
  return (
    await h.client<{ stock_quantity: number }[]>`
      select stock_quantity from product_variants where id = ${variantId}`
  )[0]!.stock_quantity;
}

/** A paid, CUSTOMER-OWNED order. Returns the order id, the customer token, and the variant. */
async function paidCustomerOrder(qty = 2, price = 1000) {
  const cust = await signupAndLoginCustomer(h);
  const { variantId } = await seedSimpleProduct(h, { price, stock: 10 });
  const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, qty);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/customer`)
    .set('Cookie', cartCookie)
    .set('Authorization', `Bearer ${cust.accessToken}`)
    .expect(200);
  const co = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cartCookie)
    .set('Authorization', `Bearer ${cust.accessToken}`)
    .expect(201);
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
  await waitForInvoice(h, orderId);
  return { orderId, cust, variantId };
}

async function orderItems(orderId: string) {
  return h.client<{ id: string; quantity: number }[]>`
    select id, quantity from order_items where order_id = ${orderId} order by created_at`;
}

describe('POST /store/v1/customers/me/orders/:id/returns — request', () => {
  it('records a requested return, window OPEN when not yet delivered', async () => {
    const { orderId, cust } = await paidCustomerOrder();
    const items = await orderItems(orderId);
    const res = await request(h.http())
      .post(`/store/v1/customers/me/orders/${orderId}/returns`)
      .set('Authorization', `Bearer ${cust.accessToken}`)
      .send({
        type: 'withdrawal',
        items: [{ orderItemId: items[0]!.id, quantity: 1 }],
        reason: 'changed mind',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      status: 'requested',
      type: 'withdrawal',
      withinWithdrawalWindow: true,
    });
  });

  it('flags out-of-window when delivered > 14 days ago', async () => {
    const { orderId, cust } = await paidCustomerOrder();
    // Drive to delivered, then backdate the delivered history row > 14 days.
    const admin = await seedAdminAndLogin(h, 'admin');
    for (const to of ['fulfilled', 'shipped', 'delivered']) {
      await request(h.http())
        .post(`/admin/v1/orders/${orderId}/transitions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ to })
        .expect(200);
    }
    await h.client`
      update order_status_history set created_at = now() - interval '20 days'
      where order_id = ${orderId} and to_status = 'delivered'`;
    const items = await orderItems(orderId);
    const res = await request(h.http())
      .post(`/store/v1/customers/me/orders/${orderId}/returns`)
      .set('Authorization', `Bearer ${cust.accessToken}`)
      .send({ type: 'withdrawal', items: [{ orderItemId: items[0]!.id, quantity: 1 }] })
      .expect(201);
    expect(res.body.withinWithdrawalWindow).toBe(false);
  });

  it('404s a return request on another customer’s order (no IDOR)', async () => {
    const { orderId } = await paidCustomerOrder();
    const other = await signupAndLoginCustomer(h);
    const items = await orderItems(orderId);
    await request(h.http())
      .post(`/store/v1/customers/me/orders/${orderId}/returns`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({ type: 'return', items: [{ orderItemId: items[0]!.id, quantity: 1 }] })
      .expect(404);
  });
});

describe('admin approve / reject', () => {
  it('approve a FULL withdrawal → full refund incl. shipping, restock, order refunded', async () => {
    const { orderId, cust, variantId } = await paidCustomerOrder(2, 1000); // 2000 + 500 ship = 2500
    const items = await orderItems(orderId);
    const stockBefore = await stockOf(variantId);
    const reqRes = await request(h.http())
      .post(`/store/v1/customers/me/orders/${orderId}/returns`)
      .set('Authorization', `Bearer ${cust.accessToken}`)
      .send({ type: 'withdrawal', items: [{ orderItemId: items[0]!.id, quantity: 2 }] })
      .expect(201);
    const returnId = reqRes.body.id as string;
    const admin = await seedAdminAndLogin(h, 'admin');

    const res = await request(h.http())
      .post(`/admin/v1/returns/${returnId}/approve`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body).toMatchObject({ status: 'refunded' });
    expect(res.body.refundId).toBeTruthy();

    expect(await orderStatus(orderId)).toBe('refunded');
    const refund = await h.client<
      { amount: number }[]
    >`select amount from refunds where order_id = ${orderId}`;
    expect(refund[0]!.amount).toBe(2500); // full incl shipping
    expect(await stockOf(variantId)).toBe(stockBefore + 2); // restocked
    const cn =
      await h.client`select 1 from invoices where order_id = ${orderId} and type='credit_note'`;
    expect(cn).toHaveLength(1);
  });

  it('approve a PARTIAL return → line refund (no shipping), order partially_refunded', async () => {
    const { orderId, cust, variantId } = await paidCustomerOrder(3, 1000); // 3000 + 500 = 3500
    const items = await orderItems(orderId);
    const stockBefore = await stockOf(variantId);
    const reqRes = await request(h.http())
      .post(`/store/v1/customers/me/orders/${orderId}/returns`)
      .set('Authorization', `Bearer ${cust.accessToken}`)
      .send({ type: 'return', items: [{ orderItemId: items[0]!.id, quantity: 1 }] })
      .expect(201);
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/returns/${reqRes.body.id}/approve`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(await orderStatus(orderId)).toBe('partially_refunded');
    const refund = await h.client<
      { amount: number }[]
    >`select amount from refunds where order_id = ${orderId}`;
    expect(refund[0]!.amount).toBe(1000); // one unit, no shipping
    expect(await stockOf(variantId)).toBe(stockBefore + 1);
  });

  it('reject → status rejected with reason, order untouched, second resolve 409', async () => {
    const { orderId, cust } = await paidCustomerOrder();
    const items = await orderItems(orderId);
    const reqRes = await request(h.http())
      .post(`/store/v1/customers/me/orders/${orderId}/returns`)
      .set('Authorization', `Bearer ${cust.accessToken}`)
      .send({ type: 'return', items: [{ orderItemId: items[0]!.id, quantity: 1 }] })
      .expect(201);
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/returns/${reqRes.body.id}/reject`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ reason: 'outside policy' })
      .expect(200);
    expect(await orderStatus(orderId)).toBe('paid'); // unchanged

    // A second resolve (approve) on a non-requested return → 409.
    await request(h.http())
      .post(`/admin/v1/returns/${reqRes.body.id}/approve`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(409);
  });

  it('staff CANNOT approve (403 — orders:write is admin+)', async () => {
    const { orderId, cust } = await paidCustomerOrder();
    const items = await orderItems(orderId);
    const reqRes = await request(h.http())
      .post(`/store/v1/customers/me/orders/${orderId}/returns`)
      .set('Authorization', `Bearer ${cust.accessToken}`)
      .send({ type: 'return', items: [{ orderItemId: items[0]!.id, quantity: 1 }] })
      .expect(201);
    const staff = await seedAdminAndLogin(h, 'staff');
    await request(h.http())
      .post(`/admin/v1/returns/${reqRes.body.id}/approve`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(403);
  });
});
