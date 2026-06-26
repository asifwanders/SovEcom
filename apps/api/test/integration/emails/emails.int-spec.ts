/**
 * Email notifications integration. Full AppModule, real Postgres, mail
 * UNCONFIGURED (no SMTP/Brevo env) so MailService no-ops → every send logs `sent` without
 * actually sending. Covers: the three event listeners write an `email_logs` row; the admin
 * list + resend endpoints; permissions (orders:read list / orders:write resend); resend
 * re-renders + writes a fresh row; tenant-scoped lookup (unknown id → 404) + bad uuid → 400.
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
  DEFAULT_TENANT_ID,
  type PaymentsHarness,
} from '../payments/_payments-harness';

let h: PaymentsHarness;

beforeAll(async () => {
  h = await bootPaymentsApp();
}, 30_000);
afterAll(async () => {
  await h.app.close();
  await h.client.end();
});
beforeEach(async () => {
  await resetOrderState(h); // CASCADE clears email_logs (FK → orders)
  await h.redis.flushdb();
  resetStripeMock();
});

interface EmailLogRow {
  id: string;
  order_id: string | null;
  reference_id: string | null;
  recipient: string;
  type: string;
  status: string;
  attempts: number;
  provider_message_id: string | null;
}

async function waitForEmail(
  orderId: string,
  type: string,
  timeoutMs = 5000,
): Promise<EmailLogRow | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await h.client<EmailLogRow[]>`
      select id, order_id, reference_id, recipient, type, status, attempts, provider_message_id
      from email_logs where order_id = ${orderId} and type = ${type} order by created_at desc`;
    if (rows.length > 0) return rows[0]!;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function checkoutOrder(qty = 2, price = 1000): Promise<string> {
  const { variantId } = await seedSimpleProduct(h, { price, stock: 10 });
  const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, qty);
  const co = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cartCookie)
    .send({});
  return co.body.id as string;
}

async function payOrder(orderId: string): Promise<void> {
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
}

describe('email listeners → email_logs', () => {
  it('order.created → an order_confirmation log (status sent, mail no-op)', async () => {
    const orderId = await checkoutOrder();
    const row = await waitForEmail(orderId, 'order_confirmation');
    expect(row).not.toBeNull();
    expect(row!.status).toBe('sent');
    expect(row!.attempts).toBe(1);
    expect(row!.recipient).toContain('@');
    expect(row!.reference_id).toBeNull();
  });

  it('order.shipped → an order_shipped log', async () => {
    const orderId = await checkoutOrder();
    await payOrder(orderId);
    const admin = await seedAdminAndLogin(h, 'admin');
    for (const to of ['fulfilled', 'shipped']) {
      await request(h.http())
        .post(`/admin/v1/orders/${orderId}/transitions`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ to })
        .expect(200);
    }
    expect(await waitForEmail(orderId, 'order_shipped')).not.toBeNull();
  });

  it('refund.issued → a refund_issued log carrying the refund id as reference', async () => {
    const orderId = await checkoutOrder(3, 1000);
    await payOrder(orderId);
    const admin = await seedAdminAndLogin(h, 'admin');
    const refund = await request(h.http())
      .post(`/admin/v1/orders/${orderId}/refunds`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ idempotencyKey: `idem-${orderId}` })
      .expect(201);
    const row = await waitForEmail(orderId, 'refund_issued');
    expect(row).not.toBeNull();
    expect(row!.reference_id).toBe(refund.body.refundId);
  });
});

describe('admin email-log API', () => {
  it('lists logs (orders:read) and filters by type/order', async () => {
    const orderId = await checkoutOrder();
    await waitForEmail(orderId, 'order_confirmation');
    const staff = await seedAdminAndLogin(h, 'staff'); // staff has orders:read

    const all = await request(h.http())
      .get('/admin/v1/emails')
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(200);
    expect(all.body.total).toBeGreaterThanOrEqual(1);

    const filtered = await request(h.http())
      .get(`/admin/v1/emails?type=order_confirmation&orderId=${orderId}`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(200);
    expect(filtered.body.data.length).toBeGreaterThanOrEqual(1);
    expect(filtered.body.data.every((r: EmailLogRow) => r.type === 'order_confirmation')).toBe(
      true,
    );
  });

  it('admin can resend → writes a FRESH log row; staff is forbidden (orders:write)', async () => {
    const orderId = await checkoutOrder();
    const first = await waitForEmail(orderId, 'order_confirmation');
    const admin = await seedAdminAndLogin(h, 'admin');
    const staff = await seedAdminAndLogin(h, 'staff');

    // staff cannot resend (orders:write is admin+)
    await request(h.http())
      .post(`/admin/v1/emails/${first!.id}/resend`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(403);

    const resent = await request(h.http())
      .post(`/admin/v1/emails/${first!.id}/resend`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(resent.body.id).not.toBe(first!.id); // a new row
    expect(resent.body.type).toBe('order_confirmation');

    const count = await h.client<{ n: number }[]>`
      select count(*)::int as n from email_logs where order_id = ${orderId} and type = 'order_confirmation'`;
    expect(count[0]!.n).toBe(2);
  });

  it('resend of an unknown id → 404; a malformed id → 400', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post('/admin/v1/emails/00000000-0000-0000-0000-0000000000ff/resend')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(404);
    await request(h.http())
      .post('/admin/v1/emails/not-a-uuid/resend')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(400);
  });
});
