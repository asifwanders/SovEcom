/**
 * Admin disputes API integration. Full AppModule, real Postgres.
 * Covers the read surface (list + filter by status/order) feeding the order-detail panel, the
 * unfreeze-fulfillment action (clears orders.fulfillment_frozen), tenant scoping, and permissions
 * (orders:read list / orders:write unfreeze).
 */
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bootPaymentsApp,
  resetOrderState,
  resetStripeMock,
  seedAdminAndLogin,
  DEFAULT_TENANT_ID,
  type PaymentsHarness,
} from './_payments-harness';

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
  await h.redis.flushdb();
  resetStripeMock();
});

/** Seed a paid+frozen order with a payment and an open dispute (under `tenantId`). Returns ids. */
async function seedDisputedOrder(
  status = 'open',
  tenantId = DEFAULT_TENANT_ID,
): Promise<{ orderId: string; disputeId: string }> {
  const orderId = randomUUID();
  const paymentId = randomUUID();
  const disputeId = randomUUID();
  const addr = JSON.stringify({
    name: 'B',
    line1: '1 st',
    city: 'C',
    postalCode: '1',
    country: 'FR',
  });
  await h.client`
    insert into orders (id, tenant_id, order_number, email, status, currency, subtotal_amount,
      total_amount, tax_amount, tax_inclusive, fulfillment_frozen, shipping_address, billing_address)
    values (${orderId}, ${tenantId}, ${`DSP-${orderId.slice(0, 8)}`}, ${'b@t.invalid'},
      ${'paid'}, ${'EUR'}, ${2000}, ${2000}, ${0}, ${false}, ${true}, ${addr}::jsonb, ${addr}::jsonb)`;
  await h.client`
    insert into payments (id, tenant_id, order_id, provider, amount, currency, status)
    values (${paymentId}, ${tenantId}, ${orderId}, ${'stripe'}, ${2000}, ${'EUR'}, ${'succeeded'})`;
  await h.client`
    insert into disputes (id, tenant_id, order_id, payment_id, provider, provider_dispute_id,
      amount, currency, reason, status, provider_status)
    values (${disputeId}, ${tenantId}, ${orderId}, ${paymentId}, ${'stripe'},
      ${`dp_${disputeId.slice(0, 8)}`}, ${2000}, ${'EUR'}, ${'fraudulent'}, ${status}, ${'needs_response'})`;
  return { orderId, disputeId };
}

async function frozenOf(orderId: string): Promise<boolean> {
  const r = await h.client<{ fulfillment_frozen: boolean }[]>`
    select fulfillment_frozen from orders where id = ${orderId}`;
  return r[0]!.fulfillment_frozen;
}

describe('GET /admin/v1/disputes', () => {
  it('lists disputes (orders:read) and filters by status + orderId', async () => {
    const { orderId } = await seedDisputedOrder('open');
    await seedDisputedOrder('lost');
    const staff = await seedAdminAndLogin(h, 'staff'); // staff has orders:read

    const all = await request(h.http())
      .get('/admin/v1/disputes')
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(200);
    expect(all.body.total).toBeGreaterThanOrEqual(2);

    const open = await request(h.http())
      .get('/admin/v1/disputes?status=open')
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(200);
    expect(open.body.data.every((d: { status: string }) => d.status === 'open')).toBe(true);

    const byOrder = await request(h.http())
      .get(`/admin/v1/disputes?orderId=${orderId}`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(200);
    expect(byOrder.body.data).toHaveLength(1);
    expect(byOrder.body.data[0].orderId).toBe(orderId);
  });
});

describe('POST /admin/v1/disputes/:id/unfreeze-fulfillment', () => {
  it('clears the order fulfillment freeze (admin); staff is forbidden (orders:write)', async () => {
    const { orderId, disputeId } = await seedDisputedOrder('lost');
    expect(await frozenOf(orderId)).toBe(true);

    const staff = await seedAdminAndLogin(h, 'staff');
    await request(h.http())
      .post(`/admin/v1/disputes/${disputeId}/unfreeze-fulfillment`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(403);
    expect(await frozenOf(orderId)).toBe(true); // unchanged

    const admin = await seedAdminAndLogin(h, 'admin');
    const res = await request(h.http())
      .post(`/admin/v1/disputes/${disputeId}/unfreeze-fulfillment`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.orderId).toBe(orderId);
    expect(await frozenOf(orderId)).toBe(false); // freeze cleared
  });

  it('404s an unknown dispute id; 400s a malformed id', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(`/admin/v1/disputes/${randomUUID()}/unfreeze-fulfillment`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(404);
    await request(h.http())
      .post('/admin/v1/disputes/not-a-uuid/unfreeze-fulfillment')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(400);
  });

  it('is tenant-scoped: cannot list or unfreeze another tenant’s dispute', async () => {
    const otherTenant = '01900000-0000-7000-8000-0000000000d1';
    await h.client`insert into tenants (id, name, slug, settings) values (${otherTenant}, ${'Other'}, ${'other-dsp'}, ${'{}'}::jsonb) on conflict (id) do nothing`;
    const { orderId, disputeId } = await seedDisputedOrder('open', otherTenant);
    const admin = await seedAdminAndLogin(h, 'admin'); // DEFAULT_TENANT admin

    // Listing as the default-tenant admin must NOT surface the other tenant's dispute.
    const list = await request(h.http())
      .get('/admin/v1/disputes')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(list.body.data.some((d: { id: string }) => d.id === disputeId)).toBe(false);

    // Unfreeze of the other tenant's dispute → 404 (tenant-scoped lookup), and its order stays frozen.
    await request(h.http())
      .post(`/admin/v1/disputes/${disputeId}/unfreeze-fulfillment`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(404);
    expect(await frozenOf(orderId)).toBe(true);

    await h.client`delete from disputes where tenant_id = ${otherTenant}`;
    await h.client`delete from payments where tenant_id = ${otherTenant}`;
    await h.client`delete from orders where tenant_id = ${otherTenant}`;
    await h.client`delete from tenants where id = ${otherTenant}`;
  });
});
