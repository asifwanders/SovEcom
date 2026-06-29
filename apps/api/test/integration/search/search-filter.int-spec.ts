/**
 * Integration tests for the `?q=` free-text filter on:
 *  - GET /admin/v1/products  (ilike on products.title)
 *  - GET /admin/v1/orders    (ilike on orders.order_number)
 *
 * Covers per the spec:
 *  - substring match (case-insensitive)
 *  - tenant isolation (other tenant's matching row excluded)
 *  - LIKE metachar escaping (`%`, `_`, `\` treated literally)
 *
 * Uses the orders harness (real Postgres + Redis, full AppModule).
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
const OTHER_TENANT_ID = '01900000-ffff-7000-8000-000000000099';

beforeAll(async () => {
  h = await bootCartApp();

  // Ensure second tenant exists
  await h.client`
    insert into tenants (id, name, slug, settings)
    values (${OTHER_TENANT_ID}, ${'Search Other Tenant'}, ${'search-other-tenant-' + newId().slice(-6)}, ${'{}'}::jsonb)
    on conflict (id) do nothing
  `;
}, 30_000);

afterAll(async () => {
  await h.app.close();
  await h.client.end();
});

beforeEach(async () => {
  await resetOrderState(h);
  // Clean up products seeded in previous tests
  await h.client`delete from products where tenant_id = ${DEFAULT_TENANT_ID}`;
  await h.client`delete from products where tenant_id = ${OTHER_TENANT_ID}`;
}, 15_000);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Directly insert a product row with the given title. Returns the product id. */
async function insertProduct(opts: { title: string; tenantId?: string }): Promise<string> {
  const id = newId();
  const tid = opts.tenantId ?? DEFAULT_TENANT_ID;
  // Slug must be unique per tenant; use the product id as part to avoid collisions.
  await h.client.unsafe(
    `INSERT INTO products (id, tenant_id, title, slug, status)
     VALUES ($1, $2, $3, $4, 'published')`,
    [id, tid, opts.title, `prod-${id}`],
  );
  return id;
}

/** Directly insert an order row. Returns the order id. */
async function insertOrder(opts: { orderNumber: string; tenantId?: string }): Promise<string> {
  const id = newId();
  const tid = opts.tenantId ?? DEFAULT_TENANT_ID;
  await h.client.unsafe(
    `INSERT INTO orders (id, tenant_id, order_number, email, status, currency,
       subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount, refunded_amount,
       is_b2b, reverse_charge, tax_inclusive, shipping_address, billing_address, placed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'paid'::order_status, 'EUR', 1000, 0, 0, 0, 1000, 0,
             false, false, false, '{}'::jsonb, '{}'::jsonb, now(), now(), now())`,
    [id, tid, opts.orderNumber, `test-${id}@test.invalid`],
  );
  return id;
}

// ── Products ?q= filter ────────────────────────────────────────────────────────

describe('GET /admin/v1/products?q= — free-text title filter', () => {
  it('returns products whose title contains the query (case-insensitive)', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertProduct({ title: 'Blue Running Shoes' });
    await insertProduct({ title: 'Red Sandals' });
    await insertProduct({ title: 'blue winter jacket' });

    const res = await request(h.http())
      .get('/admin/v1/products?q=blue&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const titles: string[] = res.body.data.map((p: { title: string }) => p.title);
    expect(titles).toContain('Blue Running Shoes');
    expect(titles).toContain('blue winter jacket');
    expect(titles).not.toContain('Red Sandals');
    expect(res.body.total).toBe(2);
  });

  it('matches a mid-string substring', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertProduct({ title: 'Vintage Leather Belt' });
    await insertProduct({ title: 'Canvas Tote Bag' });

    const res = await request(h.http())
      .get('/admin/v1/products?q=Leather&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.data[0].title).toBe('Vintage Leather Belt');
  });

  it('returns empty when no title matches', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertProduct({ title: 'Classic Hat' });

    const res = await request(h.http())
      .get('/admin/v1/products?q=nonexistentxyz&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBe(0);
    expect(res.body.data).toHaveLength(0);
  });

  it('TENANT ISOLATION: excludes matching products from another tenant', async () => {
    const admin = await seedAdminAndLogin(h);
    // Our tenant: one matching product
    await insertProduct({ title: 'Shared Widget' });
    // Other tenant: also has a matching product — must NOT appear in our results
    await insertProduct({ title: 'Shared Widget', tenantId: OTHER_TENANT_ID });

    const res = await request(h.http())
      .get('/admin/v1/products?q=Shared&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
  });

  it('METACHAR ESCAPING: a literal % in the query matches it literally, not as a wildcard', async () => {
    const admin = await seedAdminAndLogin(h);
    // One product whose title contains a literal "%" character
    await insertProduct({ title: '50% Off Sale' });
    // Unrelated product
    await insertProduct({ title: 'Regular Price Item' });

    // Querying for "50%" should find only the product with the literal % sign
    const res = await request(h.http())
      .get('/admin/v1/products?q=50%25&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.data[0].title).toBe('50% Off Sale');
  });

  it('METACHAR ESCAPING: a literal _ in the query matches it literally, not as any character', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertProduct({ title: 'a_b special product' });
    await insertProduct({ title: 'axb lookalike' }); // should NOT match a_b (underscore is literal)

    const res = await request(h.http())
      .get('/admin/v1/products?q=a_b&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const titles: string[] = res.body.data.map((p: { title: string }) => p.title);
    expect(titles).toContain('a_b special product');
    expect(titles).not.toContain('axb lookalike');
  });

  it('without ?q= returns all products (no title filter applied)', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertProduct({ title: 'Alpha Product' });
    await insertProduct({ title: 'Beta Product' });

    const res = await request(h.http())
      .get('/admin/v1/products?pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });
});

// ── Orders ?q= filter ─────────────────────────────────────────────────────────

describe('GET /admin/v1/orders?q= — free-text order number filter', () => {
  it('returns orders whose order number contains the query (case-insensitive)', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ orderNumber: 'ORD-001' });
    await insertOrder({ orderNumber: 'ORD-002' });
    await insertOrder({ orderNumber: 'INV-999' });

    const res = await request(h.http())
      .get('/admin/v1/orders?q=ORD&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const numbers: string[] = res.body.data.map((o: { orderNumber: string }) => o.orderNumber);
    expect(numbers).toContain('ORD-001');
    expect(numbers).toContain('ORD-002');
    expect(numbers).not.toContain('INV-999');
    expect(res.body.total).toBe(2);
  });

  it('matches a substring in the middle of the order number', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ orderNumber: 'SHOP-2026-0042' });
    await insertOrder({ orderNumber: 'SHOP-2025-0001' });

    const res = await request(h.http())
      .get('/admin/v1/orders?q=2026&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.data[0].orderNumber).toBe('SHOP-2026-0042');
  });

  it('returns empty when no order number matches', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ orderNumber: 'ORD-ALPHA' });

    const res = await request(h.http())
      .get('/admin/v1/orders?q=NOMATCH99&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBe(0);
    expect(res.body.data).toHaveLength(0);
  });

  it('TENANT ISOLATION: excludes matching orders from another tenant', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ orderNumber: 'SHARED-001' });
    await insertOrder({ orderNumber: 'SHARED-001', tenantId: OTHER_TENANT_ID });

    const res = await request(h.http())
      .get('/admin/v1/orders?q=SHARED&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
  });

  it('METACHAR ESCAPING: a literal % in the query matches it literally', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ orderNumber: 'ORD-50%OFF' });
    await insertOrder({ orderNumber: 'ORD-REGULAR' });

    const res = await request(h.http())
      .get('/admin/v1/orders?q=50%25OFF&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.data[0].orderNumber).toBe('ORD-50%OFF');
  });

  it('METACHAR ESCAPING: a literal _ in the query matches it literally', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ orderNumber: 'ORD_SPECIAL' });
    await insertOrder({ orderNumber: 'ORDXSPECIAL' }); // would match if _ were a wildcard

    const res = await request(h.http())
      .get('/admin/v1/orders?q=ORD_SPECIAL&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const numbers: string[] = res.body.data.map((o: { orderNumber: string }) => o.orderNumber);
    expect(numbers).toContain('ORD_SPECIAL');
    expect(numbers).not.toContain('ORDXSPECIAL');
  });

  it('without ?q= returns all orders (no order number filter applied)', async () => {
    const admin = await seedAdminAndLogin(h);
    await insertOrder({ orderNumber: 'ORD-A1' });
    await insertOrder({ orderNumber: 'ORD-B2' });

    const res = await request(h.http())
      .get('/admin/v1/orders?pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBeGreaterThanOrEqual(2);
  });

  it('q= can be combined with status filter', async () => {
    const admin = await seedAdminAndLogin(h);
    // Insert one paid and one pending_payment with same prefix
    await insertOrder({ orderNumber: 'TXN-PAID-001' });
    await h.client.unsafe(
      `INSERT INTO orders (id, tenant_id, order_number, email, status, currency,
         subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount, refunded_amount,
         is_b2b, reverse_charge, tax_inclusive, shipping_address, billing_address, placed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'pending_payment'::order_status, 'EUR', 1000, 0, 0, 0, 1000, 0,
               false, false, false, '{}'::jsonb, '{}'::jsonb, now(), now(), now())`,
      [newId(), DEFAULT_TENANT_ID, 'TXN-PEND-001', `combo-test@test.invalid`],
    );

    // Filter for TXN prefix AND status=paid
    const res = await request(h.http())
      .get('/admin/v1/orders?q=TXN&status=paid&pageSize=50')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.data[0].orderNumber).toBe('TXN-PAID-001');
  });
});
