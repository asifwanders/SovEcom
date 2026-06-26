/**
 * Admin + store order ENDPOINTS integration tests.
 *
 * Full AppModule against real Postgres + Redis. Covers:
 *  - admin GET list (tenant-scoped, paginated) + GET detail (items + status history);
 *  - admin POST transitions (legal edge ok; illegal edge → 422);
 *  - admin POST mark-paid → drives pending_payment → paid;
 *  - permission posture: staff (orders:read) can READ but NOT WRITE (403);
 *  - store GET own-orders list + detail, and the IDOR guard (another customer's order
 *    id → 404).
 *
 * Orders are created through the real store checkout so the data path is exercised
 * end-to-end (no hand-inserted orders).
 */
import request from 'supertest';
import {
  bootCartApp,
  resetOrderState,
  seedSimpleProduct,
  driveCartToCheckoutReady,
  signupAndLoginCustomer,
  seedAdminAndLogin,
  extractCartTokenCookie,
  seedShippingRate,
  type CartHarness,
} from './_orders-harness';

let h: CartHarness;

beforeAll(async () => {
  h = await bootCartApp();
}, 30_000);

afterAll(async () => {
  await h.app.close();
  await h.client.end();
});

beforeEach(async () => {
  await resetOrderState(h);
}, 10_000);

/** Create a GUEST order via real checkout; returns its public id + number. */
async function placeGuestOrder(qty = 2): Promise<{ id: string; orderNumber: string }> {
  const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 50 });
  const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, qty);
  const res = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cartCookie)
    .send({});
  if (res.status !== 201) {
    throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id as string, orderNumber: res.body.orderNumber as string };
}

/** Drive a CUSTOMER-owned cart through checkout; returns the order id. */
async function placeCustomerOrder(accessToken: string, qty = 1): Promise<{ id: string }> {
  const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 50 });
  const created = await request(h.http()).post('/store/v1/carts').send({ currency: 'EUR' });
  const cartId = created.body.cartId as string;
  const cookie = extractCartTokenCookie(created);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/customer`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ variantId, quantity: qty })
    .expect(201);
  await seedShippingRate(h, 'EUR');
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-address`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name: 'Buyer', line1: '1 rue', city: 'Paris', postalCode: '75001', country: 'FR' })
    .expect(200);
  const rates = await request(h.http())
    .get(`/store/v1/carts/${cartId}/shipping-rates`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-method`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ shippingRateId: rates.body[0].id })
    .expect(200);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/email`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ email: `buyer-${Date.now()}@test.invalid` })
    .expect(200);
  const res = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({});
  if (res.status !== 201) {
    throw new Error(`customer checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id as string };
}

describe('GET /admin/v1/orders — list', () => {
  it('lists tenant orders with pagination metadata', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await placeGuestOrder();
    await placeGuestOrder();

    const res = await request(h.http())
      .get('/admin/v1/orders?page=1&pageSize=20')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.data).toHaveLength(2);
    // No internal leakage of another tenant's rows (only DEFAULT_TENANT seeded here).
    expect(res.body.data.every((o: { status: string }) => o.status === 'pending_payment')).toBe(
      true,
    );
  });

  it('filters by status', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const a = await placeGuestOrder();
    await placeGuestOrder();
    // Mark one paid.
    await request(h.http())
      .post(`/admin/v1/orders/${a.id}/mark-paid`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const paid = await request(h.http())
      .get('/admin/v1/orders?status=paid')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(paid.body.total).toBe(1);
    expect(paid.body.data[0].id).toBe(a.id);
  });
});

describe('GET /admin/v1/orders/:id — detail', () => {
  it('returns the order with its items + status history', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder(3);

    const res = await request(h.http())
      .get(`/admin/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.order.id).toBe(order.id);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(3);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].toStatus).toBe('pending_payment');
  });

  it('404s an order in another (absent) tenant / unknown id', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .get('/admin/v1/orders/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(404);
  });
});

describe('POST /admin/v1/orders/:id/transitions', () => {
  it('drives a legal edge and appends a history row', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder();

    // `→ paid` is no longer allowed via /transitions (use a payment endpoint instead).
    // `pending_payment → cancelled` is a legal non-payment edge to exercise here.
    const res = await request(h.http())
      .post(`/admin/v1/orders/${order.id}/transitions`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ to: 'cancelled', note: 'manual' })
      .expect(200);
    expect(res.body.status).toBe('cancelled');

    const detail = await request(h.http())
      .get(`/admin/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(detail.body.history).toHaveLength(2);
    expect(detail.body.history[1].fromStatus).toBe('pending_payment');
    expect(detail.body.history[1].toStatus).toBe('cancelled');
  });

  it('REFUSES → paid via /transitions (must use a payment endpoint — Fable N2)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder();
    await request(h.http())
      .post(`/admin/v1/orders/${order.id}/transitions`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ to: 'paid' })
      .expect(422);
  });

  it('REFUSES → refunded / → partially_refunded via /transitions (must use the refunds endpoint)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder();
    // Take the order to `paid` legitimately so `refunded` is a state-machine-LEGAL edge —
    // proving the refusal is the reserved-target guard, not the transition map.
    await request(h.http())
      .post(`/admin/v1/orders/${order.id}/mark-paid`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    // `→ refunded` would be a legal edge from `paid`, but it must NOT be reachable here:
    // this generic edge moves no money and would terminally block the real RefundService.
    await request(h.http())
      .post(`/admin/v1/orders/${order.id}/transitions`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ to: 'refunded' })
      .expect(422);

    // Same for the partial-refund target.
    await request(h.http())
      .post(`/admin/v1/orders/${order.id}/transitions`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ to: 'partially_refunded' })
      .expect(422);

    // The order is untouched — still `paid`, refund money path intact.
    const detail = await request(h.http())
      .get(`/admin/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(detail.body.order.status).toBe('paid');
  });

  it('rejects an illegal edge with 422', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder();
    // pending_payment → shipped is NOT a legal edge.
    await request(h.http())
      .post(`/admin/v1/orders/${order.id}/transitions`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ to: 'shipped' })
      .expect(422);
  });
});

describe('POST /admin/v1/orders/:id/mark-paid', () => {
  it('transitions pending_payment → paid', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder();
    const res = await request(h.http())
      .post(`/admin/v1/orders/${order.id}/mark-paid`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.status).toBe('paid');
  });
});

describe('permission posture (orders:read vs orders:write)', () => {
  it('staff can READ orders', async () => {
    const staff = await seedAdminAndLogin(h, 'staff');
    await placeGuestOrder();
    await request(h.http())
      .get('/admin/v1/orders')
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(200);
  });

  it('staff CANNOT mark-paid (403 — orders:write is admin+)', async () => {
    const staff = await seedAdminAndLogin(h, 'staff');
    const order = await placeGuestOrder();
    await request(h.http())
      .post(`/admin/v1/orders/${order.id}/mark-paid`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(403);
  });

  it('staff CANNOT transition (403)', async () => {
    const staff = await seedAdminAndLogin(h, 'staff');
    const order = await placeGuestOrder();
    await request(h.http())
      .post(`/admin/v1/orders/${order.id}/transitions`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .send({ to: 'paid' })
      .expect(403);
  });
});

describe('store /store/v1/orders — own orders only (no IDOR)', () => {
  it('lists and reads MY orders', async () => {
    const { accessToken } = await signupAndLoginCustomer(h);
    const order = await placeCustomerOrder(accessToken, 2);

    const list = await request(h.http())
      .get('/store/v1/orders')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(order.id);
    // No internal leakage.
    expect(list.body[0].tenantId).toBeUndefined();
    expect(list.body[0].metadata).toBeUndefined();

    const detail = await request(h.http())
      .get(`/store/v1/orders/${order.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(detail.body.id).toBe(order.id);
    expect(detail.body.items).toHaveLength(1);
    expect(detail.body.items[0].quantity).toBe(2);
  });

  it("404s another customer's order (IDOR guard)", async () => {
    const alice = await signupAndLoginCustomer(h);
    const bob = await signupAndLoginCustomer(h);
    const aliceOrder = await placeCustomerOrder(alice.accessToken);

    // Bob tries to read Alice's order id → 404 (not 200, not 403-with-existence-leak).
    await request(h.http())
      .get(`/store/v1/orders/${aliceOrder.id}`)
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .expect(404);

    // Bob's own list does NOT include Alice's order.
    const bobList = await request(h.http())
      .get('/store/v1/orders')
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .expect(200);
    expect(bobList.body).toHaveLength(0);
  });

  it('rejects an unauthenticated caller (no customer JWT)', async () => {
    await request(h.http()).get('/store/v1/orders').expect(401);
  });
});
