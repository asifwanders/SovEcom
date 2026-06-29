/**
 * Stats ENRICH (3.22b) integration tests — the dashboard-enrichment endpoints.
 *
 * REQUIRES a live Postgres + Redis (DATABASE_URL + REDIS_URL).
 * Run with: pnpm exec jest --config jest.integration.config.js --testPathPattern=stats --runInBand
 *
 * Kept in a SEPARATE file from stats.int-spec.ts to respect the <500-line rule. Covers:
 *   - GET /admin/v1/stats/customer-breakdown — new-vs-returning split, prior-order → returning,
 *     guest exclusion, tenant isolation.
 *   - GET /admin/v1/stats/status-breakdown — counts + all-9-statuses zero-fill, windowing,
 *     tenant isolation.
 *   - GET /admin/v1/stats/timeseries (extended) — newCustomers + refundAmount per bucket,
 *     zero-fill, currency-filtered refunds, tenant isolation; revenue/orders still correct.
 *
 * Rows are inserted directly (read-only aggregate endpoints — no checkout flow needed).
 */
import request from 'supertest';
import {
  bootCartApp,
  resetOrderState,
  seedAdminAndLogin,
  DEFAULT_TENANT_ID,
  newId,
  type CartHarness,
} from '../orders/_orders-harness';

let h: CartHarness;

const OTHER_TENANT_ID = '01900000-ffff-7000-8000-000000000003';

beforeAll(async () => {
  h = await bootCartApp();
  await h.client`
    insert into tenants (id, name, slug, settings)
    values (${OTHER_TENANT_ID}, ${'Other Tenant Enrich'}, ${'other-tenant-enrich'}, ${'{}'}::jsonb)
    on conflict (id) do nothing
  `;
}, 30_000);

afterAll(async () => {
  await h.app.close();
  await h.client.end();
});

beforeEach(async () => {
  await resetOrderState(h);
  await h.client.unsafe(`TRUNCATE TABLE returns, refunds RESTART IDENTITY CASCADE`);
}, 15_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function insertOrder(opts: {
  tenantId?: string;
  status?: string;
  currency?: string;
  totalAmount?: number;
  refundedAmount?: number;
  placedAt?: Date | null;
  customerId?: string | null;
}): Promise<string> {
  const id = newId();
  const tid = opts.tenantId ?? DEFAULT_TENANT_ID;
  const status = opts.status ?? 'paid';
  const currency = opts.currency ?? 'EUR';
  const total = opts.totalAmount ?? 10000;
  const refunded = opts.refundedAmount ?? 0;
  // The porsager `postgres` driver cannot bind a raw JS Date as a parameter in `.unsafe()` —
  // its Bind step expects a string. Pass an ISO string (or null) and cast to timestamptz in SQL.
  const placed = opts.placedAt !== undefined ? opts.placedAt : new Date();
  const placedIso = placed === null ? null : placed.toISOString();
  const customerId = opts.customerId ?? null; // null = guest order
  await h.client.unsafe(
    `INSERT INTO orders (id, tenant_id, order_number, email, status, currency,
       subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount, refunded_amount,
       is_b2b, reverse_charge, tax_inclusive, shipping_address, billing_address, placed_at, customer_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::order_status, $6, $7, 0, 0, 0, $7, $8, false, false, false, '{}'::jsonb, '{}'::jsonb, $9::timestamptz, $10::uuid, now(), now())`,
    [
      id,
      tid,
      `ORD-${id}`,
      `test-${id}@test.invalid`,
      status,
      currency,
      total,
      refunded,
      placedIso,
      customerId,
    ],
  );
  return id;
}

async function insertCustomer(opts: { tenantId?: string; createdAt?: Date }): Promise<string> {
  const id = newId();
  const tid = opts.tenantId ?? DEFAULT_TENANT_ID;
  const createdIso = (opts.createdAt ?? new Date()).toISOString();
  await h.client.unsafe(
    `INSERT INTO customers (id, tenant_id, email, created_at)
     VALUES ($1, $2, $3, $4::timestamptz)`,
    [id, tid, `cust-${id}@test.invalid`, createdIso],
  );
  return id;
}

async function insertPayment(opts: {
  orderId: string;
  tenantId?: string;
  currency?: string;
  amount?: number;
}): Promise<string> {
  const id = newId();
  const tid = opts.tenantId ?? DEFAULT_TENANT_ID;
  await h.client.unsafe(
    `INSERT INTO payments (id, tenant_id, order_id, provider, amount, currency, status)
     VALUES ($1, $2, $3, 'stripe', $4, $5, 'succeeded')`,
    [id, tid, opts.orderId, opts.amount ?? 10000, opts.currency ?? 'EUR'],
  );
  return id;
}

async function insertRefund(opts: {
  orderId: string;
  paymentId: string;
  tenantId?: string;
  amount?: number;
  currency?: string;
  status?: string;
  createdAt?: Date;
}): Promise<string> {
  const id = newId();
  const tid = opts.tenantId ?? DEFAULT_TENANT_ID;
  const createdIso = (opts.createdAt ?? new Date()).toISOString();
  await h.client.unsafe(
    `INSERT INTO refunds (id, tenant_id, order_id, payment_id, amount, currency, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::refund_status, $8::timestamptz)`,
    [
      id,
      tid,
      opts.orderId,
      opts.paymentId,
      opts.amount ?? 1000,
      opts.currency ?? 'EUR',
      opts.status ?? 'succeeded',
      createdIso,
    ],
  );
  return id;
}

/** Seed an order with a fresh customer whose first-ever order is `placedAt`. Returns customerId. */
async function seedCustomerWithOrder(opts: {
  tenantId?: string;
  customerCreatedAt?: Date;
  placedAt: Date;
  status?: string;
}): Promise<string> {
  const tid = opts.tenantId ?? DEFAULT_TENANT_ID;
  const customerId = await insertCustomer({ tenantId: tid, createdAt: opts.customerCreatedAt });
  await insertOrder({
    tenantId: tid,
    customerId,
    placedAt: opts.placedAt,
    status: opts.status ?? 'paid',
  });
  return customerId;
}

// ── customer-breakdown ─────────────────────────────────────────────────────────

describe('GET /admin/v1/stats/customer-breakdown', () => {
  const FROM = '2026-06-01T00:00:00.000Z';
  const TO = '2026-06-30T23:59:59.999Z';

  it('requires auth (401)', async () => {
    await request(h.http())
      .get(`/admin/v1/stats/customer-breakdown?from=${FROM}&to=${TO}`)
      .expect(401);
  });

  it('zero-state when no orders', async () => {
    const admin = await seedAdminAndLogin(h);
    const res = await request(h.http())
      .get(`/admin/v1/stats/customer-breakdown?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.newCustomers).toBe(0);
    expect(res.body.returningCustomers).toBe(0);
    expect(res.body.guestOrdersExcluded).toBe(true);
    expect(res.body.range.from).toBeDefined();
  });

  it('a customer whose FIRST order is in-window counts NEW', async () => {
    const admin = await seedAdminAndLogin(h);
    await seedCustomerWithOrder({ placedAt: new Date('2026-06-15T12:00:00Z') });

    const res = await request(h.http())
      .get(`/admin/v1/stats/customer-breakdown?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.newCustomers).toBe(1);
    expect(res.body.returningCustomers).toBe(0);
  });

  it('a customer with a PRIOR order (before from) who also orders in-window counts RETURNING', async () => {
    const admin = await seedAdminAndLogin(h);
    const customerId = await insertCustomer({});
    // First-ever order BEFORE the window.
    await insertOrder({ customerId, placedAt: new Date('2026-04-10T12:00:00Z'), status: 'paid' });
    // Another order INSIDE the window — they re-ordered.
    await insertOrder({ customerId, placedAt: new Date('2026-06-15T12:00:00Z'), status: 'paid' });

    const res = await request(h.http())
      .get(`/admin/v1/stats/customer-breakdown?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.returningCustomers).toBe(1);
    expect(res.body.newCustomers).toBe(0);
  });

  it('excludes guest orders (customer_id IS NULL)', async () => {
    const admin = await seedAdminAndLogin(h);
    // Guest order in-window — must NOT be counted.
    await insertOrder({ customerId: null, placedAt: new Date('2026-06-15T12:00:00Z') });
    // One real new customer alongside.
    await seedCustomerWithOrder({ placedAt: new Date('2026-06-16T12:00:00Z') });

    const res = await request(h.http())
      .get(`/admin/v1/stats/customer-breakdown?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.newCustomers).toBe(1);
    expect(res.body.returningCustomers).toBe(0);
  });

  it('does not count customers whose only order is OUTSIDE the window', async () => {
    const admin = await seedAdminAndLogin(h);
    await seedCustomerWithOrder({ placedAt: new Date('2026-05-15T12:00:00Z') });

    const res = await request(h.http())
      .get(`/admin/v1/stats/customer-breakdown?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.newCustomers).toBe(0);
    expect(res.body.returningCustomers).toBe(0);
  });

  it('TENANT ISOLATION: other-tenant customers/orders are not counted', async () => {
    const admin = await seedAdminAndLogin(h);
    await seedCustomerWithOrder({ placedAt: new Date('2026-06-15T12:00:00Z') }); // ours: 1 new
    await seedCustomerWithOrder({
      tenantId: OTHER_TENANT_ID,
      placedAt: new Date('2026-06-15T12:00:00Z'),
    });
    await seedCustomerWithOrder({
      tenantId: OTHER_TENANT_ID,
      placedAt: new Date('2026-06-16T12:00:00Z'),
    });

    const res = await request(h.http())
      .get(`/admin/v1/stats/customer-breakdown?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.newCustomers).toBe(1);
    expect(res.body.returningCustomers).toBe(0);
  });
});

// ── status-breakdown ───────────────────────────────────────────────────────────

describe('GET /admin/v1/stats/status-breakdown', () => {
  const FROM = '2026-06-01T00:00:00.000Z';
  const TO = '2026-06-30T23:59:59.999Z';

  it('emits ALL 9 statuses zero-filled when there are no orders', async () => {
    const admin = await seedAdminAndLogin(h);
    const res = await request(h.http())
      .get(`/admin/v1/stats/status-breakdown?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.statuses).toHaveLength(9);
    expect(res.body.statuses.every((s: { count: number }) => s.count === 0)).toBe(true);
    // Canonical order anchors.
    expect(res.body.statuses[0].status).toBe('pending_payment');
    expect(res.body.statuses[8].status).toBe('partially_refunded');
  });

  it('counts orders grouped by status (windowed), zero-filling absent statuses', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ status: 'paid', placedAt: new Date('2026-06-10T12:00:00Z') });
    await insertOrder({ status: 'paid', placedAt: new Date('2026-06-11T12:00:00Z') });
    await insertOrder({ status: 'cancelled', placedAt: new Date('2026-06-12T12:00:00Z') });
    // Out of window — must not count.
    await insertOrder({ status: 'paid', placedAt: new Date('2026-05-12T12:00:00Z') });

    const res = await request(h.http())
      .get(`/admin/v1/stats/status-breakdown?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.statuses).toHaveLength(9);
    const map = new Map(
      res.body.statuses.map((s: { status: string; count: number }) => [s.status, s.count]),
    );
    expect(map.get('paid')).toBe(2);
    expect(map.get('cancelled')).toBe(1);
    expect(map.get('shipped')).toBe(0);
    expect(map.get('refunded')).toBe(0);
  });

  it('excludes orders with placed_at IS NULL', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ status: 'paid', placedAt: new Date('2026-06-10T12:00:00Z') });
    await insertOrder({ status: 'paid', placedAt: null });

    const res = await request(h.http())
      .get(`/admin/v1/stats/status-breakdown?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    const map = new Map(
      res.body.statuses.map((s: { status: string; count: number }) => [s.status, s.count]),
    );
    expect(map.get('paid')).toBe(1);
  });

  it('TENANT ISOLATION: other-tenant orders are not counted', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ status: 'paid', placedAt: new Date('2026-06-10T12:00:00Z') });
    await insertOrder({
      tenantId: OTHER_TENANT_ID,
      status: 'paid',
      placedAt: new Date('2026-06-10T12:00:00Z'),
    });

    const res = await request(h.http())
      .get(`/admin/v1/stats/status-breakdown?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    const map = new Map(
      res.body.statuses.map((s: { status: string; count: number }) => [s.status, s.count]),
    );
    expect(map.get('paid')).toBe(1); // only ours
  });
});

// ── timeseries (extended fields) ───────────────────────────────────────────────

describe('GET /admin/v1/stats/timeseries (extended: newCustomers + refundAmount)', () => {
  it('every point carries newCustomers + refundAmount, zero-filled', async () => {
    const admin = await seedAdminAndLogin(h);
    const res = await request(h.http())
      .get('/admin/v1/stats/timeseries?from=2026-06-01&to=2026-06-03&granularity=day')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.points.length).toBeGreaterThanOrEqual(3);
    for (const p of res.body.points) {
      expect(typeof p.newCustomers).toBe('number');
      expect(typeof p.refundAmount).toBe('number');
      expect(p.newCustomers).toBe(0);
      expect(p.refundAmount).toBe(0);
    }
  });

  it('buckets newCustomers by customers.created_at (NOT placed_at)', async () => {
    const admin = await seedAdminAndLogin(h);
    // Two customers created on June 2; one on June 3.
    await insertCustomer({ createdAt: new Date('2026-06-02T08:00:00Z') });
    await insertCustomer({ createdAt: new Date('2026-06-02T20:00:00Z') });
    await insertCustomer({ createdAt: new Date('2026-06-03T10:00:00Z') });

    // `to` is end-of-day so the June-3 10:00 customer falls inside the window (a bare
    // `to=2026-06-03` is midnight — anything later that day would be excluded).
    const res = await request(h.http())
      .get('/admin/v1/stats/timeseries?from=2026-06-01&to=2026-06-03T23:59:59.999Z&granularity=day')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const points = res.body.points as Array<{ bucket: string; newCustomers: number }>;
    expect(points.find((p) => p.bucket === '2026-06-02')?.newCustomers).toBe(2);
    expect(points.find((p) => p.bucket === '2026-06-03')?.newCustomers).toBe(1);
    expect(points.find((p) => p.bucket === '2026-06-01')?.newCustomers).toBe(0);
  });

  it('buckets succeeded refunds by refunds.created_at, summing integer cents', async () => {
    const admin = await seedAdminAndLogin(h);
    const orderId = await insertOrder({
      status: 'paid',
      placedAt: new Date('2026-06-01T10:00:00Z'),
    });
    const paymentId = await insertPayment({ orderId });
    await insertRefund({
      orderId,
      paymentId,
      amount: 1500,
      createdAt: new Date('2026-06-02T09:00:00Z'),
    });
    await insertRefund({
      orderId,
      paymentId,
      amount: 500,
      createdAt: new Date('2026-06-02T18:00:00Z'),
    });

    const res = await request(h.http())
      .get('/admin/v1/stats/timeseries?from=2026-06-01&to=2026-06-03&granularity=day')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const points = res.body.points as Array<{ bucket: string; refundAmount: number }>;
    expect(points.find((p) => p.bucket === '2026-06-02')?.refundAmount).toBe(2000);
    expect(points.find((p) => p.bucket === '2026-06-01')?.refundAmount).toBe(0);
  });

  it('refundAmount only counts SUCCEEDED refunds in the resolved currency', async () => {
    const admin = await seedAdminAndLogin(h);
    const orderId = await insertOrder({
      status: 'paid',
      placedAt: new Date('2026-06-01T10:00:00Z'),
    });
    const paymentId = await insertPayment({ orderId });
    // Succeeded EUR — counts.
    await insertRefund({
      orderId,
      paymentId,
      amount: 1000,
      status: 'succeeded',
      createdAt: new Date('2026-06-02T09:00:00Z'),
    });
    // Pending — excluded.
    await insertRefund({
      orderId,
      paymentId,
      amount: 9999,
      status: 'pending',
      createdAt: new Date('2026-06-02T09:00:00Z'),
    });
    // Different currency — excluded (never mix currencies).
    await insertRefund({
      orderId,
      paymentId,
      amount: 8888,
      currency: 'USD',
      status: 'succeeded',
      createdAt: new Date('2026-06-02T09:00:00Z'),
    });

    const res = await request(h.http())
      .get('/admin/v1/stats/timeseries?from=2026-06-01&to=2026-06-03&granularity=day')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const points = res.body.points as Array<{ bucket: string; refundAmount: number }>;
    expect(points.find((p) => p.bucket === '2026-06-02')?.refundAmount).toBe(1000);
  });

  it('existing revenue/orders remain correct alongside the new fields', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({
      status: 'paid',
      totalAmount: 5000,
      placedAt: new Date('2026-06-02T12:00:00Z'),
    });
    await insertOrder({
      status: 'cancelled',
      totalAmount: 9999,
      placedAt: new Date('2026-06-02T12:00:00Z'),
    });

    const res = await request(h.http())
      .get('/admin/v1/stats/timeseries?from=2026-06-01&to=2026-06-03&granularity=day')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const june2 = (
      res.body.points as Array<{ bucket: string; revenue: number; orders: number }>
    ).find((p) => p.bucket === '2026-06-02');
    expect(june2?.revenue).toBe(5000);
    expect(june2?.orders).toBe(1);
  });

  it('TENANT ISOLATION: other-tenant customers + refunds excluded from the series', async () => {
    const admin = await seedAdminAndLogin(h);
    // Ours: 1 new customer + a 1000-cent refund on June 2.
    await insertCustomer({ createdAt: new Date('2026-06-02T08:00:00Z') });
    const ourOrder = await insertOrder({
      status: 'paid',
      placedAt: new Date('2026-06-01T10:00:00Z'),
    });
    const ourPayment = await insertPayment({ orderId: ourOrder });
    await insertRefund({
      orderId: ourOrder,
      paymentId: ourPayment,
      amount: 1000,
      createdAt: new Date('2026-06-02T09:00:00Z'),
    });

    // Other tenant: 3 customers + a big refund on June 2 — must NOT appear.
    await insertCustomer({
      tenantId: OTHER_TENANT_ID,
      createdAt: new Date('2026-06-02T08:00:00Z'),
    });
    await insertCustomer({
      tenantId: OTHER_TENANT_ID,
      createdAt: new Date('2026-06-02T09:00:00Z'),
    });
    await insertCustomer({
      tenantId: OTHER_TENANT_ID,
      createdAt: new Date('2026-06-02T10:00:00Z'),
    });
    const otherOrder = await insertOrder({
      tenantId: OTHER_TENANT_ID,
      status: 'paid',
      placedAt: new Date('2026-06-01T10:00:00Z'),
    });
    const otherPayment = await insertPayment({ orderId: otherOrder, tenantId: OTHER_TENANT_ID });
    await insertRefund({
      orderId: otherOrder,
      paymentId: otherPayment,
      tenantId: OTHER_TENANT_ID,
      amount: 99999,
      createdAt: new Date('2026-06-02T09:00:00Z'),
    });

    const res = await request(h.http())
      .get('/admin/v1/stats/timeseries?from=2026-06-01&to=2026-06-03&granularity=day')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const june2 = (
      res.body.points as Array<{ bucket: string; newCustomers: number; refundAmount: number }>
    ).find((p) => p.bucket === '2026-06-02');
    expect(june2?.newCustomers).toBe(1); // only ours
    expect(june2?.refundAmount).toBe(1000); // only ours
  });
});
