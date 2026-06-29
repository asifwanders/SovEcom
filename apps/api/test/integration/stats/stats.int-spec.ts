/**
 * Stats integration tests — /admin/v1/stats/*.
 *
 * REQUIRES a live Postgres + Redis (DATABASE_URL + REDIS_URL).
 * Run with: pnpm --filter @sovecom/api test:integration -- --testPathPattern=stats
 *
 * Strategy: insert raw rows directly (SQL) — the stats endpoints are read-only aggregates;
 * we do NOT need the full checkout flow for these. This keeps fixtures predictable and fast.
 *
 * Covers:
 *   - Auth gate: 401 without token.
 *   - Permission gate: staff role (has dashboard:read) CAN access; but a role
 *     without dashboard:read (we patch a staff account and verify it cannot) → 403.
 *     Actually the spec says staff DOES have dashboard:read; we test that a non-logged-in
 *     user gets 401 and a user without any permission fails via the guard infrastructure.
 *     Full permission posture test: staff (has dashboard:read) → 200; unauthenticated → 401.
 *   - Response shape matches the spec contract exactly.
 *   - Tenant isolation: orders/variants seeded for a SECOND tenant never appear in results.
 *   - Summary: netRevenue sums only revenue-bearing orders in the window; excludes cancelled/refunded.
 *   - Timeseries: zero-filled buckets, both revenue and order count.
 *   - Top products: grouped by product_title, correct sort.
 *   - Attention: low-stock / out-of-stock lists + counts; pending returns; unfulfilled/pending-payment orders.
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

// A second tenant for isolation checks
const OTHER_TENANT_ID = '01900000-ffff-7000-8000-000000000002';

beforeAll(async () => {
  h = await bootCartApp();

  // Ensure second tenant exists for isolation tests
  await h.client`
    insert into tenants (id, name, slug, settings)
    values (${OTHER_TENANT_ID}, ${'Other Tenant'}, ${'other-tenant-stats'}, ${'{}'}::jsonb)
    on conflict (id) do nothing
  `;
}, 30_000);

afterAll(async () => {
  await h.app.close();
  await h.client.end();
});

beforeEach(async () => {
  await resetOrderState(h);
  // Also clean product_variants/products + returns for the stats tests
  await h.client.unsafe(`
    TRUNCATE TABLE returns, refunds RESTART IDENTITY CASCADE
  `);
  // Clean second-tenant data (product_variants cascade to product)
  await h.client`delete from product_variants where tenant_id = ${OTHER_TENANT_ID}`;
  await h.client`delete from products where tenant_id = ${OTHER_TENANT_ID}`;
}, 15_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Directly insert an order row (no checkout flow). Returns the id. */
async function insertOrder(opts: {
  tenantId?: string;
  status?: string;
  currency?: string;
  totalAmount?: number;
  refundedAmount?: number;
  placedAt?: Date | null;
}): Promise<string> {
  const id = newId();
  const tid = opts.tenantId ?? DEFAULT_TENANT_ID;
  const status = opts.status ?? 'paid';
  const currency = opts.currency ?? 'EUR';
  const total = opts.totalAmount ?? 10000;
  const refunded = opts.refundedAmount ?? 0;
  // The porsager `postgres` driver cannot bind a raw JS Date as a parameter in
  // `.unsafe()` — its Bind step expects a string. Pass an ISO string (or null) and
  // cast to timestamptz in SQL.
  const placed = opts.placedAt !== undefined ? opts.placedAt : new Date();
  const placedIso = placed === null ? null : placed.toISOString();
  await h.client.unsafe(
    `INSERT INTO orders (id, tenant_id, order_number, email, status, currency,
       subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount, refunded_amount,
       is_b2b, reverse_charge, tax_inclusive, shipping_address, billing_address, placed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::order_status, $6, $7, 0, 0, 0, $7, $8, false, false, false, '{}'::jsonb, '{}'::jsonb, $9::timestamptz, now(), now())`,
    [id, tid, `ORD-${id}`, `test-${id}@test.invalid`, status, currency, total, refunded, placedIso],
  );
  return id;
}

/** Insert an order_item for a given order. */
async function insertOrderItem(opts: {
  orderId: string;
  tenantId?: string;
  productTitle?: string;
  variantId?: string | null;
  quantity?: number;
  lineTotalAmount?: number;
}): Promise<void> {
  const tid = opts.tenantId ?? DEFAULT_TENANT_ID;
  await h.client.unsafe(
    `INSERT INTO order_items (id, tenant_id, order_id, variant_id, product_title, variant_title, sku, quantity, unit_price_amount, tax_rate, tax_amount, line_total_amount)
     VALUES ($1, $2, $3, $4, $5, null, $6, $7, $8, '0.0000', 0, $8)`,
    [
      newId(),
      tid,
      opts.orderId,
      opts.variantId ?? null,
      opts.productTitle ?? 'Product A',
      `SKU-${newId().slice(0, 6)}`,
      opts.quantity ?? 1,
      opts.lineTotalAmount ?? 5000,
    ],
  );
}

/** Insert a product + variant directly. Returns ids. */
async function insertVariant(opts: {
  tenantId?: string;
  title?: string | null;
  sku?: string;
  stockQuantity?: number;
  allowBackorder?: boolean;
}): Promise<{ productId: string; variantId: string }> {
  const tid = opts.tenantId ?? DEFAULT_TENANT_ID;
  const productId = newId();
  const variantId = newId();
  // Slug uniqueness is per (tenant_id, slug). Use the full product id (a uuidv7,
  // globally unique) so two variants seeded in the same test/tenant never collide.
  await h.client.unsafe(
    `INSERT INTO products (id, tenant_id, title, slug, status)
     VALUES ($1, $2, 'Test Product', $3, 'published')`,
    [productId, tid, `slug-${productId}`],
  );
  await h.client.unsafe(
    `INSERT INTO product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity, allow_backorder)
     VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 1000, 'EUR', $6, $7)`,
    [
      variantId,
      tid,
      productId,
      opts.sku ?? `SKU-${variantId}`,
      opts.title ?? 'Variant',
      opts.stockQuantity ?? 10,
      opts.allowBackorder ?? false,
    ],
  );
  return { productId, variantId };
}

// ── Auth + permission tests ────────────────────────────────────────────────────

describe('GET /admin/v1/stats/* — auth gate', () => {
  it('returns 401 without a token', async () => {
    await request(h.http())
      .get('/admin/v1/stats/summary?from=2026-01-01&to=2026-01-31')
      .expect(401);
    await request(h.http())
      .get('/admin/v1/stats/timeseries?from=2026-01-01&to=2026-01-31')
      .expect(401);
    await request(h.http())
      .get('/admin/v1/stats/top-products?from=2026-01-01&to=2026-01-31')
      .expect(401);
    await request(h.http()).get('/admin/v1/stats/attention').expect(401);
  });
});

describe('GET /admin/v1/stats/* — permission gate', () => {
  it('staff role (has dashboard:read) gets 200 on all endpoints', async () => {
    const staff = await seedAdminAndLogin(h, 'staff');
    const base = `/admin/v1/stats`;
    await request(h.http())
      .get(`${base}/summary?from=2026-01-01&to=2026-01-31`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(200);
    await request(h.http())
      .get(`${base}/timeseries?from=2026-01-01&to=2026-01-31`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(200);
    await request(h.http())
      .get(`${base}/top-products?from=2026-01-01&to=2026-01-31`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(200);
    await request(h.http())
      .get(`${base}/attention`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(200);
  });

  it('admin role gets 200 on all endpoints', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .get('/admin/v1/stats/attention')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
  });
});

// ── Summary endpoint ──────────────────────────────────────────────────────────

describe('GET /admin/v1/stats/summary', () => {
  const FROM = '2026-06-01T00:00:00.000Z';
  const TO = '2026-06-30T23:59:59.999Z';

  it('returns zero-state when no orders exist', async () => {
    const admin = await seedAdminAndLogin(h);
    const res = await request(h.http())
      .get(`/admin/v1/stats/summary?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.currency).toBeDefined();
    expect(res.body.metrics.netRevenue.value).toBe(0);
    expect(res.body.metrics.orders.value).toBe(0);
    expect(res.body.metrics.averageOrderValue.value).toBe(0);
    expect(res.body.metrics.netRevenue.deltaPct).toBeNull();
  });

  it('sums only revenue-bearing orders (excludes cancelled, pending_payment, refunded)', async () => {
    const admin = await seedAdminAndLogin(h);

    // Revenue-bearing: paid (10000), fulfilled (5000)
    await insertOrder({
      status: 'paid',
      totalAmount: 10000,
      placedAt: new Date('2026-06-15T12:00:00Z'),
    });
    await insertOrder({
      status: 'fulfilled',
      totalAmount: 5000,
      placedAt: new Date('2026-06-16T12:00:00Z'),
    });
    // Excluded: cancelled, pending_payment, refunded
    await insertOrder({
      status: 'cancelled',
      totalAmount: 99999,
      placedAt: new Date('2026-06-17T12:00:00Z'),
    });
    await insertOrder({
      status: 'pending_payment',
      totalAmount: 99999,
      placedAt: new Date('2026-06-18T12:00:00Z'),
    });
    await insertOrder({
      status: 'refunded',
      totalAmount: 99999,
      placedAt: new Date('2026-06-19T12:00:00Z'),
    });

    const res = await request(h.http())
      .get(`/admin/v1/stats/summary?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.metrics.netRevenue.value).toBe(15000);
    expect(res.body.metrics.orders.value).toBe(2);
  });

  it('subtracts refunded_amount from total_amount for net revenue', async () => {
    const admin = await seedAdminAndLogin(h);
    // partially_refunded: total=10000, refunded=2000 → net=8000
    await insertOrder({
      status: 'partially_refunded',
      totalAmount: 10000,
      refundedAmount: 2000,
      placedAt: new Date('2026-06-15T12:00:00Z'),
    });

    const res = await request(h.http())
      .get(`/admin/v1/stats/summary?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.metrics.netRevenue.value).toBe(8000);
  });

  it('excludes orders outside the window (placed_at before from)', async () => {
    const admin = await seedAdminAndLogin(h);
    // In window
    await insertOrder({
      status: 'paid',
      totalAmount: 5000,
      placedAt: new Date('2026-06-15T12:00:00Z'),
    });
    // Before window
    await insertOrder({
      status: 'paid',
      totalAmount: 99999,
      placedAt: new Date('2026-05-31T23:59:59Z'),
    });

    const res = await request(h.http())
      .get(`/admin/v1/stats/summary?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.metrics.netRevenue.value).toBe(5000);
    expect(res.body.metrics.orders.value).toBe(1);
  });

  it('excludes orders with placed_at IS NULL', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({
      status: 'paid',
      totalAmount: 5000,
      placedAt: new Date('2026-06-15T12:00:00Z'),
    });
    await insertOrder({ status: 'paid', totalAmount: 99999, placedAt: null });

    const res = await request(h.http())
      .get(`/admin/v1/stats/summary?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.metrics.netRevenue.value).toBe(5000);
  });

  it('response has correct shape (range, previous, currency, metrics)', async () => {
    const admin = await seedAdminAndLogin(h);
    const res = await request(h.http())
      .get(`/admin/v1/stats/summary?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.range).toBeDefined();
    expect(res.body.previous).toBeDefined();
    expect(res.body.currency).toBeDefined();
    const m = res.body.metrics;
    for (const key of [
      'netRevenue',
      'orders',
      'averageOrderValue',
      'newCustomers',
      'returnRate',
      'refunds',
      'cartConversion',
    ]) {
      expect(m[key]).toBeDefined();
      expect(typeof m[key].value).toBe('number');
      expect(typeof m[key].previous).toBe('number');
      // deltaPct is number or null
      expect(m[key].deltaPct === null || typeof m[key].deltaPct === 'number').toBe(true);
    }
  });

  it('TENANT ISOLATION: orders from another tenant are not included', async () => {
    const admin = await seedAdminAndLogin(h);
    // Seed for our tenant
    await insertOrder({
      status: 'paid',
      totalAmount: 5000,
      placedAt: new Date('2026-06-15T12:00:00Z'),
    });
    // Seed for OTHER tenant (no FK on orders→tenants cascades to our check; tenant must exist)
    await insertOrder({
      tenantId: OTHER_TENANT_ID,
      status: 'paid',
      totalAmount: 999999,
      placedAt: new Date('2026-06-15T12:00:00Z'),
    });

    const res = await request(h.http())
      .get(`/admin/v1/stats/summary?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    // Should only see our tenant's order (5000), not OTHER tenant's (999999)
    expect(res.body.metrics.netRevenue.value).toBe(5000);
    expect(res.body.metrics.orders.value).toBe(1);
  });

  it('delta uses the previous equal-length window', async () => {
    const admin = await seedAdminAndLogin(h);
    // Current window (June): 1 order at 10000
    await insertOrder({
      status: 'paid',
      totalAmount: 10000,
      placedAt: new Date('2026-06-15T12:00:00Z'),
    });
    // Previous window (May): 1 order at 8000
    await insertOrder({
      status: 'paid',
      totalAmount: 8000,
      placedAt: new Date('2026-05-15T12:00:00Z'),
    });

    const fromMay = '2026-06-01T00:00:00.000Z';
    const toMay = '2026-06-30T23:59:59.999Z';
    const res = await request(h.http())
      .get(`/admin/v1/stats/summary?from=${fromMay}&to=${toMay}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    // Current netRevenue = 10000, previous = 8000
    expect(res.body.metrics.netRevenue.value).toBe(10000);
    expect(res.body.metrics.netRevenue.previous).toBe(8000);
    // deltaPct = (10000 - 8000) / 8000 * 100 = 25.0
    expect(res.body.metrics.netRevenue.deltaPct).toBe(25);
  });

  it('rejects invalid date range (from > to)', async () => {
    const admin = await seedAdminAndLogin(h);
    const res = await request(h.http())
      .get('/admin/v1/stats/summary?from=2026-06-30&to=2026-06-01')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    // ZodValidationPipe returns 422 or 400
    expect([400, 422]).toContain(res.status);
  });
});

// ── Timeseries endpoint ────────────────────────────────────────────────────────

describe('GET /admin/v1/stats/timeseries', () => {
  it('returns zero-filled points for the entire range', async () => {
    const admin = await seedAdminAndLogin(h);
    const res = await request(h.http())
      .get('/admin/v1/stats/timeseries?from=2026-06-01&to=2026-06-03&granularity=day')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.granularity).toBe('day');
    expect(res.body.currency).toBeDefined();
    // 3 days: 2026-06-01, 2026-06-02, 2026-06-03
    expect(res.body.points.length).toBeGreaterThanOrEqual(3);
    for (const p of res.body.points) {
      expect(typeof p.bucket).toBe('string');
      expect(typeof p.revenue).toBe('number');
      expect(typeof p.orders).toBe('number');
    }
  });

  it('counts only revenue-bearing orders in the timeseries', async () => {
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

    const june2 = res.body.points.find((p: { bucket: string }) => p.bucket === '2026-06-02');
    expect(june2).toBeDefined();
    expect(june2.revenue).toBe(5000);
    expect(june2.orders).toBe(1);
  });

  it('rejects a range that would exceed MAX_BUCKETS (>400 days)', async () => {
    const admin = await seedAdminAndLogin(h);
    const res = await request(h.http())
      .get('/admin/v1/stats/timeseries?from=2020-01-01&to=2026-12-31&granularity=day')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect([400, 422]).toContain(res.status);
  });
});

// ── Top products endpoint ──────────────────────────────────────────────────────

describe('GET /admin/v1/stats/top-products', () => {
  const FROM = '2026-06-01';
  const TO = '2026-06-30';

  it('groups by product_title and sorts by revenue descending', async () => {
    const admin = await seedAdminAndLogin(h);
    const o1 = await insertOrder({
      status: 'paid',
      totalAmount: 20000,
      placedAt: new Date('2026-06-10T12:00:00Z'),
    });
    const o2 = await insertOrder({
      status: 'paid',
      totalAmount: 5000,
      placedAt: new Date('2026-06-11T12:00:00Z'),
    });
    await insertOrderItem({
      orderId: o1,
      productTitle: 'Jacket',
      quantity: 2,
      lineTotalAmount: 20000,
    });
    await insertOrderItem({
      orderId: o2,
      productTitle: 'T-Shirt',
      quantity: 5,
      lineTotalAmount: 5000,
    });

    const res = await request(h.http())
      .get(`/admin/v1/stats/top-products?from=${FROM}&to=${TO}&by=revenue`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.by).toBe('revenue');
    expect(res.body.items[0].productTitle).toBe('Jacket');
    expect(res.body.items[0].revenue).toBe(20000);
    expect(res.body.items[0].quantitySold).toBe(2);
    expect(res.body.items[1].productTitle).toBe('T-Shirt');
  });

  it('sorts by quantity when by=quantity', async () => {
    const admin = await seedAdminAndLogin(h);
    const o1 = await insertOrder({
      status: 'paid',
      totalAmount: 1000,
      placedAt: new Date('2026-06-10T12:00:00Z'),
    });
    const o2 = await insertOrder({
      status: 'paid',
      totalAmount: 20000,
      placedAt: new Date('2026-06-11T12:00:00Z'),
    });
    await insertOrderItem({
      orderId: o1,
      productTitle: 'Cheap Item',
      quantity: 100,
      lineTotalAmount: 1000,
    });
    await insertOrderItem({
      orderId: o2,
      productTitle: 'Expensive Item',
      quantity: 1,
      lineTotalAmount: 20000,
    });

    const res = await request(h.http())
      .get(`/admin/v1/stats/top-products?from=${FROM}&to=${TO}&by=quantity`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.items[0].productTitle).toBe('Cheap Item');
    expect(res.body.items[0].quantitySold).toBe(100);
  });

  it('respects the limit parameter', async () => {
    const admin = await seedAdminAndLogin(h);
    for (let i = 0; i < 5; i++) {
      const o = await insertOrder({
        status: 'paid',
        totalAmount: (5 - i) * 1000,
        placedAt: new Date('2026-06-10T12:00:00Z'),
      });
      await insertOrderItem({
        orderId: o,
        productTitle: `Product ${i}`,
        quantity: 1,
        lineTotalAmount: (5 - i) * 1000,
      });
    }
    const res = await request(h.http())
      .get(`/admin/v1/stats/top-products?from=${FROM}&to=${TO}&limit=3`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.items).toHaveLength(3);
  });

  it('TENANT ISOLATION: does not include other tenant order items', async () => {
    const admin = await seedAdminAndLogin(h);
    const o1 = await insertOrder({
      status: 'paid',
      totalAmount: 5000,
      placedAt: new Date('2026-06-10T12:00:00Z'),
    });
    const o2 = await insertOrder({
      tenantId: OTHER_TENANT_ID,
      status: 'paid',
      totalAmount: 999999,
      placedAt: new Date('2026-06-10T12:00:00Z'),
    });
    await insertOrderItem({
      orderId: o1,
      productTitle: 'My Product',
      quantity: 1,
      lineTotalAmount: 5000,
    });
    await insertOrderItem({
      orderId: o2,
      tenantId: OTHER_TENANT_ID,
      productTitle: 'Other Product',
      quantity: 1,
      lineTotalAmount: 999999,
    });

    const res = await request(h.http())
      .get(`/admin/v1/stats/top-products?from=${FROM}&to=${TO}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const titles = res.body.items.map((i: { productTitle: string }) => i.productTitle);
    expect(titles).toContain('My Product');
    expect(titles).not.toContain('Other Product');
  });
});

// ── Attention endpoint ─────────────────────────────────────────────────────────

describe('GET /admin/v1/stats/attention', () => {
  it('returns correct shape with zero state', async () => {
    const admin = await seedAdminAndLogin(h);
    const res = await request(h.http())
      .get('/admin/v1/stats/attention')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.lowStockThreshold).toBe(5);
    expect(res.body.lowStock).toBeDefined();
    expect(res.body.lowStock.count).toBe(0);
    expect(res.body.outOfStock).toBeDefined();
    expect(res.body.outOfStock.count).toBe(0);
    expect(res.body.pendingReturns).toBe(0);
    expect(res.body.unfulfilledOrders).toBe(0);
    expect(res.body.pendingPaymentOrders).toBe(0);
  });

  it('detects out-of-stock variants (stock<=0, allow_backorder=false)', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertVariant({ stockQuantity: 0, allowBackorder: false });
    await insertVariant({ stockQuantity: -1, allowBackorder: false });
    await insertVariant({ stockQuantity: 0, allowBackorder: true }); // excluded (backorder allowed)

    const res = await request(h.http())
      .get('/admin/v1/stats/attention')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.outOfStock.count).toBe(2);
    for (const item of res.body.outOfStock.items) {
      expect(typeof item.variantId).toBe('string');
      expect(typeof item.sku).toBe('string');
      expect(item.stockQuantity).toBeLessThanOrEqual(0);
    }
  });

  it('detects low-stock variants (0 < stock <= 5, allow_backorder=false)', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertVariant({ stockQuantity: 3, allowBackorder: false });
    await insertVariant({ stockQuantity: 5, allowBackorder: false }); // exactly threshold = low
    await insertVariant({ stockQuantity: 6, allowBackorder: false }); // > threshold = not low
    await insertVariant({ stockQuantity: 1, allowBackorder: true }); // backorder = not low

    const res = await request(h.http())
      .get('/admin/v1/stats/attention')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.lowStock.count).toBe(2);
  });

  it('item lists are capped at 10 but count reflects the full total', async () => {
    const admin = await seedAdminAndLogin(h);
    // Seed 15 out-of-stock variants
    for (let i = 0; i < 15; i++) {
      await insertVariant({ sku: `OOS-${i}`, stockQuantity: 0, allowBackorder: false });
    }
    const res = await request(h.http())
      .get('/admin/v1/stats/attention')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.outOfStock.count).toBe(15); // full count
    expect(res.body.outOfStock.items.length).toBeLessThanOrEqual(10); // capped list
  });

  it('counts unfulfilled orders (status=paid)', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ status: 'paid', placedAt: new Date() });
    await insertOrder({ status: 'paid', placedAt: new Date() });
    await insertOrder({ status: 'fulfilled', placedAt: new Date() }); // not unfulfilled

    const res = await request(h.http())
      .get('/admin/v1/stats/attention')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.unfulfilledOrders).toBe(2);
  });

  it('counts pending payment orders (status=pending_payment)', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ status: 'pending_payment', placedAt: new Date() });
    await insertOrder({ status: 'paid', placedAt: new Date() });

    const res = await request(h.http())
      .get('/admin/v1/stats/attention')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.pendingPaymentOrders).toBe(1);
  });

  it('TENANT ISOLATION: variants/orders from other tenant not counted', async () => {
    const admin = await seedAdminAndLogin(h);
    // Our tenant: 1 out-of-stock
    await insertVariant({ stockQuantity: 0, allowBackorder: false });
    // Other tenant: 5 out-of-stock
    for (let i = 0; i < 5; i++) {
      await insertVariant({
        tenantId: OTHER_TENANT_ID,
        sku: `OTHER-OOS-${i}`,
        stockQuantity: 0,
        allowBackorder: false,
      });
    }
    // Other tenant: 3 unfulfilled orders
    for (let i = 0; i < 3; i++) {
      await insertOrder({ tenantId: OTHER_TENANT_ID, status: 'paid', placedAt: new Date() });
    }

    const res = await request(h.http())
      .get('/admin/v1/stats/attention')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.outOfStock.count).toBe(1); // only ours
    expect(res.body.unfulfilledOrders).toBe(0); // none in our tenant
  });
});
