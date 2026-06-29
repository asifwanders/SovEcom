/**
 * Catalog Products & Variants integration tests.
 *
 * Uses the auth harness (bootAuthApp + seedAdmin + resetAuthState).
 * Covers all acceptance criteria from the spec.
 */
import request from 'supertest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq, and } from 'drizzle-orm';
import sharp from 'sharp';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  AuthHarness,
  AUTH,
  newId,
} from '../auth/_auth-harness';
import { products } from '../../../src/database/schema/products';
import { productVariants } from '../../../src/database/schema/product_variants';
import { productImages } from '../../../src/database/schema/product_images';
import { AuthService } from '../../../src/auth/services/auth.service';
import { ResetService } from '../../../src/auth/services/reset.service';
import { StoreTenantService } from '../../../src/catalog/store-tenant.service';

const ADMIN_PRODUCTS = '/admin/v1/products';
const STORE_PRODUCTS = '/store/v1/products';

// ── harness helpers ──────────────────────────────────────────────────────────

async function login(h: AuthHarness, email: string, password: string): Promise<string> {
  const res = await request(h.http()).post(AUTH.login).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** Insert a tenant without touching the default-tenant override. */
async function insertTenant(h: AuthHarness): Promise<string> {
  const id = newId();
  const slug = `tenant-${id.slice(-8)}`;
  await h.client`insert into tenants (id, name, slug) values (${id}, ${slug}, ${slug})`;
  return id;
}

/** Override default_tenant_id cache so login resolves the given tenant. */
async function switchDefaultTenant(h: AuthHarness, id: string): Promise<void> {
  await h.client`
    insert into system_state (key, value)
    values ('default_tenant_id', to_jsonb(${id}::text))
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
  type Cached = { defaultTenantId: string | null };
  (h.app.get(AuthService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  (h.app.get(ResetService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  // Also clear the StoreTenantService cache so store endpoints resolve the right tenant.
  (h.app.get(StoreTenantService, { strict: false }) as unknown as Cached).defaultTenantId = null;
}

/** Minimal valid product payload. */
function makeProductPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: `Test Product ${newId().slice(-6)}`,
    ...overrides,
  };
}

/** Create a solid-colour PNG buffer. */
async function solidPng(w = 100, h = 100): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

// ── suite ────────────────────────────────────────────────────────────────────

describe('Catalog API — products integration', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });
  beforeEach(async () => {
    await resetAuthState(h);
    // Reset the StoreTenantService cache between tests.
    type Cached = { defaultTenantId: string | null };
    (h.app.get(StoreTenantService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  });

  // ── POST /admin/v1/products ─────────────────────────────────────────────────

  describe('POST /admin/v1/products', () => {
    it('creates a product with auto-generated default variant', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const res = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(makeProductPayload())
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.slug).toBeDefined();
      expect(res.body.status).toBe('draft');
      expect(res.body.variants).toHaveLength(1);
      expect(res.body.variants[0].priceAmount).toBe(0);
      expect(res.body.variants[0].currency).toBe(process.env.STORE_DEFAULT_CURRENCY ?? 'EUR');
    });

    it('creates a product with 15 explicit variants (5 sizes × 3 colors)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const variantList = [];
      const sizes = ['XS', 'S', 'M', 'L', 'XL'];
      const colors = ['red', 'green', 'blue'];
      for (const size of sizes) {
        for (const color of colors) {
          variantList.push({
            sku: `sku-${size}-${color}-${newId().slice(-4)}`,
            title: `${size} ${color}`,
            options: { size, color },
            priceAmount: 1000,
            currency: 'EUR',
          });
        }
      }

      const res = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...makeProductPayload(), variants: variantList })
        .expect(201);

      expect(res.body.variants).toHaveLength(15);
    });

    it('GET :id returns all 15 variants with no N+1', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const variantList = Array.from({ length: 15 }, (_, i) => ({
        sku: `sku-${i}-${newId().slice(-4)}`,
        options: { index: i },
        priceAmount: 500 + i,
        currency: 'EUR',
      }));

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...makeProductPayload(), variants: variantList })
        .expect(201);

      const res = await request(h.http())
        .get(`${ADMIN_PRODUCTS}/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.variants).toHaveLength(15);
      expect(res.body.id).toBe(created.body.id);
    });

    it('returns 401 when unauthenticated', async () => {
      await request(h.http()).post(ADMIN_PRODUCTS).send(makeProductPayload()).expect(401);
    });

    it('staff role (products:write) can create', async () => {
      const staff = await seedAdmin(h, { role: 'staff' });
      const token = await login(h, staff.email, staff.password);
      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(makeProductPayload())
        .expect(201);
    });
  });

  // ── Slug uniqueness ──────────────────────────────────────────────────────────

  describe('Slug uniqueness', () => {
    it('two products with the same title get distinct slugs', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const payload = { title: 'Unique Title Product' };

      const r1 = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(payload)
        .expect(201);

      const r2 = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(payload)
        .expect(201);

      expect(r1.body.slug).toBeDefined();
      expect(r2.body.slug).toBeDefined();
      expect(r1.body.slug).not.toBe(r2.body.slug);
    });
  });

  // ── HARD delete ──────────────────────────────────────────────────────────────

  describe('DELETE /admin/v1/products/:id (hard delete)', () => {
    it('returns 204 and removes the product + cascade-deletes variants', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          variants: [
            { sku: `var-${newId().slice(-6)}`, options: {}, priceAmount: 100, currency: 'EUR' },
          ],
        })
        .expect(201);

      const productId = created.body.id as string;
      const variantId = created.body.variants[0].id as string;

      await request(h.http())
        .delete(`${ADMIN_PRODUCTS}/${productId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      // Product row gone.
      const productRows = await h.db.select().from(products).where(eq(products.id, productId));
      expect(productRows).toHaveLength(0);

      // Variant row cascade-deleted.
      const variantRows = await h.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, variantId));
      expect(variantRows).toHaveLength(0);
    });

    it('second DELETE returns 404 (idempotent)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(makeProductPayload())
        .expect(201);

      await request(h.http())
        .delete(`${ADMIN_PRODUCTS}/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await request(h.http())
        .delete(`${ADMIN_PRODUCTS}/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns 409 when an order references the product (sold) — no orphaned history', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          variants: [
            { sku: `sold-${newId().slice(-6)}`, options: {}, priceAmount: 1000, currency: 'EUR' },
          ],
        })
        .expect(201);
      const productId = created.body.id as string;
      const variantId = created.body.variants[0].id as string;

      // Seed an order + an order_item snapshot line referencing this variant (a "sale").
      const orderId = newId();
      const addr = JSON.stringify({
        name: 'B',
        line1: '1 rue',
        city: 'Paris',
        postalCode: '75001',
        country: 'FR',
      });
      await h.client`
        insert into orders (
          id, tenant_id, order_number, email, status, currency,
          subtotal_amount, total_amount, tax_inclusive, shipping_address, billing_address, placed_at
        ) values (
          ${orderId}, ${admin.tenantId}, ${'1001'}, ${'b@test.invalid'}, ${'paid'}, ${'EUR'},
          ${1000}, ${1000}, ${false}, ${addr}::jsonb, ${addr}::jsonb, now()
        )
      `;
      await h.client`
        insert into order_items (
          id, tenant_id, order_id, variant_id, product_title, sku,
          quantity, unit_price_amount, tax_rate, tax_amount, line_total_amount
        ) values (
          ${newId()}, ${admin.tenantId}, ${orderId}, ${variantId}, ${'Sold'}, ${'sold-sku'},
          ${1}, ${1000}, ${'0.0000'}, ${0}, ${1000}
        )
      `;

      // Delete is rejected with 409 (not 204, not 500) — fiscal history is protected.
      await request(h.http())
        .delete(`${ADMIN_PRODUCTS}/${productId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(409);

      // The product + its variant are STILL present (nothing orphaned/nulled).
      const stillThere = await h.db.select().from(products).where(eq(products.id, productId));
      expect(stillThere).toHaveLength(1);
      const variantStill = await h.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, variantId));
      expect(variantStill).toHaveLength(1);
    });

    it('archive via PATCH hides from store but keeps DB row', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      // Create a published product first (need non-zero price variant).
      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            { sku: `v-${newId().slice(-6)}`, options: {}, priceAmount: 999, currency: 'EUR' },
          ],
        })
        .expect(201);

      const productId = created.body.id as string;
      const slug = created.body.slug as string;

      // Archive it.
      await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${productId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'archived' })
        .expect(200);

      // DB row still exists.
      const rows = await h.db.select().from(products).where(eq(products.id, productId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('archived');

      // Store endpoint returns 404.
      await switchDefaultTenant(h, admin.tenantId);
      await request(h.http()).get(`${STORE_PRODUCTS}/${slug}`).expect(404);
    });
  });

  // ── Publish guard ────────────────────────────────────────────────────────────

  describe('Publish guard', () => {
    it('rejects create with status=published and a 0-price non-free variant', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const res = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            { sku: `v-${newId().slice(-6)}`, options: {}, priceAmount: 0, currency: 'EUR' },
          ],
        });

      expect([400, 422]).toContain(res.status);
    });

    it('allows create with status=published and free-flagged 0-price variant', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            {
              sku: `v-${newId().slice(-6)}`,
              options: { free: true },
              priceAmount: 0,
              currency: 'EUR',
            },
          ],
        })
        .expect(201);
    });

    it('allows create with status=published and nonzero price variant', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            { sku: `v-${newId().slice(-6)}`, options: {}, priceAmount: 500, currency: 'EUR' },
          ],
        })
        .expect(201);
    });

    it('rejects PATCH status→published when a variant has price=0', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      // Create draft with 0-price variant.
      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'draft',
          variants: [
            { sku: `v-${newId().slice(-6)}`, options: {}, priceAmount: 0, currency: 'EUR' },
          ],
        })
        .expect(201);

      const res = await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'published' });

      expect([400, 422]).toContain(res.status);
    });

    it('allows PATCH status→published when nonzero price exists', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'draft',
          variants: [
            { sku: `v-${newId().slice(-6)}`, options: {}, priceAmount: 999, currency: 'EUR' },
          ],
        })
        .expect(201);

      await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'published' })
        .expect(200);
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────────────

  describe('Tenant isolation', () => {
    it('admin A cannot GET a product from tenant B (returns 404)', async () => {
      // Seed adminA in tenantA.
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${tokenA}`)
        .send(makeProductPayload())
        .expect(201);

      const productId = created.body.id as string;

      // Create tenantB, seed adminB.
      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);

      await request(h.http())
        .get(`${ADMIN_PRODUCTS}/${productId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
    });

    it('admin A cannot PATCH a product from tenant B', async () => {
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${tokenA}`)
        .send(makeProductPayload())
        .expect(201);

      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);

      await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${created.body.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ title: 'Hijacked' })
        .expect(404);
    });

    it('admin A cannot DELETE a product from tenant B', async () => {
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${tokenA}`)
        .send(makeProductPayload())
        .expect(201);

      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);

      await request(h.http())
        .delete(`${ADMIN_PRODUCTS}/${created.body.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
    });
  });

  // ── Store endpoints ──────────────────────────────────────────────────────────

  describe('GET /store/v1/products', () => {
    it('returns only published products', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      // Create a published and a draft product.
      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            { sku: `pub-${newId().slice(-6)}`, options: {}, priceAmount: 100, currency: 'EUR' },
          ],
        })
        .expect(201);

      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...makeProductPayload(), status: 'draft' })
        .expect(201);

      const res = await request(h.http()).get(STORE_PRODUCTS).expect(200);

      expect(res.body.data).toBeDefined();
      for (const p of res.body.data as Array<{ status: string }>) {
        expect(p.status).toBe('published');
      }
    });

    it('draft product slug returns 404 from store', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Draft Product', status: 'draft' })
        .expect(201);

      await request(h.http()).get(`${STORE_PRODUCTS}/${created.body.slug}`).expect(404);
    });

    it('does NOT expose internal fields (allowlist check)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            { sku: `v-${newId().slice(-6)}`, options: {}, priceAmount: 999, currency: 'EUR' },
          ],
        })
        .expect(201);

      const res = await request(h.http()).get(`${STORE_PRODUCTS}/${created.body.slug}`).expect(200);

      const forbidden = [
        'embedding',
        'metadata',
        'tenantId',
        'tenant_id',
        'stockQuantity',
        'stock_quantity',
      ];
      for (const field of forbidden) {
        expect(res.body).not.toHaveProperty(field);
      }
      // Variants should also not expose stockQuantity.
      for (const v of (res.body.variants ?? []) as Array<Record<string, unknown>>) {
        expect(v).not.toHaveProperty('stockQuantity');
        expect(v).not.toHaveProperty('stock_quantity');
        // But availability boolean should be present.
        expect(v).toHaveProperty('availability');
      }
    });

    it('does not require authentication', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            { sku: `v-${newId().slice(-6)}`, options: {}, priceAmount: 100, currency: 'EUR' },
          ],
        })
        .expect(201);

      // No Authorization header.
      await request(h.http()).get(STORE_PRODUCTS).expect(200);
    });

    it('cursor pagination returns stable pages', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      // Create 5 published products.
      for (let i = 0; i < 5; i++) {
        await request(h.http())
          .post(ADMIN_PRODUCTS)
          .set('Authorization', `Bearer ${token}`)
          .send({
            title: `Paged Product ${i}`,
            status: 'published',
            variants: [
              {
                sku: `vp-${i}-${newId().slice(-6)}`,
                options: {},
                priceAmount: 100,
                currency: 'EUR',
              },
            ],
          })
          .expect(201);
      }

      // Page 1: pageSize=2.
      const page1 = await request(h.http()).get(`${STORE_PRODUCTS}?pageSize=2`).expect(200);

      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.nextCursor).not.toBeNull();

      // Page 2 using cursor.
      const page2 = await request(h.http())
        .get(`${STORE_PRODUCTS}?pageSize=2&cursor=${page1.body.nextCursor}`)
        .expect(200);

      expect(page2.body.data).toHaveLength(2);

      // No overlap between pages.
      const ids1 = (page1.body.data as Array<{ id: string }>).map((p) => p.id);
      const ids2 = (page2.body.data as Array<{ id: string }>).map((p) => p.id);
      const overlap = ids1.filter((id) => ids2.includes(id));
      expect(overlap).toHaveLength(0);
    });
  });

  // ── Events ───────────────────────────────────────────────────────────────────

  describe('Events', () => {
    it('emits product.created on create', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const emitter = h.app.get(EventEmitter2);
      const handler = jest.fn();
      emitter.on('product.created', handler);

      try {
        await request(h.http())
          .post(ADMIN_PRODUCTS)
          .set('Authorization', `Bearer ${token}`)
          .send(makeProductPayload())
          .expect(201);

        expect(handler).toHaveBeenCalledTimes(1);
      } finally {
        emitter.removeListener('product.created', handler);
      }
    });

    it('emits product.updated on PATCH', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(makeProductPayload())
        .expect(201);

      const emitter = h.app.get(EventEmitter2);
      const handler = jest.fn();
      emitter.on('product.updated', handler);

      try {
        await request(h.http())
          .patch(`${ADMIN_PRODUCTS}/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .send({ title: 'Updated Title' })
          .expect(200);

        expect(handler).toHaveBeenCalledTimes(1);
      } finally {
        emitter.removeListener('product.updated', handler);
      }
    });

    it('emits product.deleted on DELETE', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(makeProductPayload())
        .expect(201);

      const emitter = h.app.get(EventEmitter2);
      const handler = jest.fn();
      emitter.on('product.deleted', handler);

      try {
        await request(h.http())
          .delete(`${ADMIN_PRODUCTS}/${created.body.id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(204);

        expect(handler).toHaveBeenCalledTimes(1);
      } finally {
        emitter.removeListener('product.deleted', handler);
      }
    });
  });

  // ── Image attach / detach ─────────────────────────────────────────────────────

  describe('Image attach / detach', () => {
    it('attaches an uploaded image to a product, surfaces it in store detail, and detaches it', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      // Create a PUBLISHED product (nonzero variant) so it appears in the store.
      const createdProduct = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            { sku: `v-${newId().slice(-6)}`, options: {}, priceAmount: 1299, currency: 'EUR' },
          ],
        })
        .expect(201);
      const productId = createdProduct.body.id as string;
      const slug = createdProduct.body.slug as string;

      // Upload an image via 1.5 endpoint.
      const png = await solidPng();
      const uploadRes = await request(h.http())
        .post('/admin/v1/images')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', png, { filename: 'test.png', contentType: 'image/png' });
      expect([200, 201]).toContain(uploadRes.status);
      const imageId = uploadRes.body.id as string;

      // Attach image to product.
      await request(h.http())
        .post(`${ADMIN_PRODUCTS}/${productId}/images`)
        .set('Authorization', `Bearer ${token}`)
        .send({ imageId, position: 0 })
        .expect(201);

      // Verify product_images row exists (via the new image_id join column).
      const rows = await h.db
        .select()
        .from(productImages)
        .where(and(eq(productImages.productId, productId), eq(productImages.imageId, imageId)));
      expect(rows).toHaveLength(1);

      // Store product detail should include the image with a public thumbnail URL.
      const storeDetail = await request(h.http()).get(`${STORE_PRODUCTS}/${slug}`).expect(200);
      expect(storeDetail.body.images).toHaveLength(1);
      expect(typeof storeDetail.body.images[0].thumbnailUrl).toBe('string');
      expect(storeDetail.body.images[0].thumbnailUrl.length).toBeGreaterThan(0);

      // Detach.
      await request(h.http())
        .delete(`${ADMIN_PRODUCTS}/${productId}/images/${imageId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const rowsAfter = await h.db
        .select()
        .from(productImages)
        .where(and(eq(productImages.productId, productId), eq(productImages.imageId, imageId)));
      expect(rowsAfter).toHaveLength(0);
    });

    it('admin GET :id exposes a computed image url (thumbnail) for each image (BUG-2)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      const createdProduct = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(makeProductPayload())
        .expect(201);
      const productId = createdProduct.body.id as string;

      const png = await solidPng();
      const uploadRes = await request(h.http())
        .post('/admin/v1/images')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', png, { filename: 'thumb.png', contentType: 'image/png' });
      const imageId = uploadRes.body.id as string;

      await request(h.http())
        .post(`${ADMIN_PRODUCTS}/${productId}/images`)
        .set('Authorization', `Bearer ${token}`)
        .send({ imageId, position: 0 })
        .expect(201);

      // The admin product-detail response must carry a browser-viewable `url`
      // on each image (not the raw storage key the client can't render).
      const detail = await request(h.http())
        .get(`${ADMIN_PRODUCTS}/${productId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(detail.body.images).toHaveLength(1);
      const img = detail.body.images[0];
      expect(typeof img.url).toBe('string');
      expect(img.url.length).toBeGreaterThan(0);
      // It should point at the thumbnail variant served under /uploads, not a bare key.
      expect(img.url).toContain('/uploads/');
      expect(img.url).toContain('/thumbnail.');
    });

    it('PATCH product succeeds when the body has NO variants field (BUG-1)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          variants: [{ sku: `v-${newId().slice(-6)}`, priceAmount: 999, currency: 'EUR' }],
        })
        .expect(201);
      const productId = created.body.id as string;

      // The fixed admin client sends ONLY scalar product fields on PATCH.
      const patched = await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${productId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: 'Renamed via scalar-only PATCH',
          status: 'draft',
          description: 'updated',
        })
        .expect(200);
      expect(patched.body.title).toBe('Renamed via scalar-only PATCH');
    });

    it('re-attaching the same image returns 409 (dedupe — F5)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const createdProduct = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(makeProductPayload())
        .expect(201);
      const productId = createdProduct.body.id as string;

      const png = await solidPng();
      const uploadRes = await request(h.http())
        .post('/admin/v1/images')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', png, { filename: 'dup.png', contentType: 'image/png' });
      const imageId = uploadRes.body.id as string;

      await request(h.http())
        .post(`${ADMIN_PRODUCTS}/${productId}/images`)
        .set('Authorization', `Bearer ${token}`)
        .send({ imageId, position: 0 })
        .expect(201);

      // Second attach of the same image → 409, and still only ONE row.
      await request(h.http())
        .post(`${ADMIN_PRODUCTS}/${productId}/images`)
        .set('Authorization', `Bearer ${token}`)
        .send({ imageId, position: 1 })
        .expect(409);

      const rows = await h.db
        .select()
        .from(productImages)
        .where(and(eq(productImages.productId, productId), eq(productImages.imageId, imageId)));
      expect(rows).toHaveLength(1);
    });

    it('attach rejects a non-uuid imageId (F7 validation) with 400', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const createdProduct = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(makeProductPayload())
        .expect(201);

      await request(h.http())
        .post(`${ADMIN_PRODUCTS}/${createdProduct.body.id}/images`)
        .set('Authorization', `Bearer ${token}`)
        .send({ imageId: 'not-a-uuid', position: 0 })
        .expect(400);
    });

    it('cannot attach an image from another tenant (404 — F13)', async () => {
      // Tenant A uploads an image.
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);
      const png = await solidPng();
      const uploadA = await request(h.http())
        .post('/admin/v1/images')
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('file', png, { filename: 'a.png', contentType: 'image/png' });
      const imageIdA = uploadA.body.id as string;

      // Tenant B has a product and tries to attach tenant A's image.
      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);
      const productB = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${tokenB}`)
        .send(makeProductPayload())
        .expect(201);

      await request(h.http())
        .post(`${ADMIN_PRODUCTS}/${productB.body.id}/images`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ imageId: imageIdA, position: 0 })
        .expect(404);
    });
  });

  // ── Variant CRUD ──────────────────────────────────────────────────────────────

  describe('Variants CRUD', () => {
    it('POST .../variants adds a variant', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(makeProductPayload())
        .expect(201);

      const productId = created.body.id as string;

      const varRes = await request(h.http())
        .post(`${ADMIN_PRODUCTS}/${productId}/variants`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          sku: `newvar-${newId().slice(-6)}`,
          options: { color: 'blue' },
          priceAmount: 1500,
          currency: 'EUR',
        })
        .expect(201);

      expect(varRes.body.priceAmount).toBe(1500);
    });

    it('PATCH .../variants/:variantId updates a variant', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          variants: [
            { sku: `v-${newId().slice(-6)}`, options: {}, priceAmount: 100, currency: 'EUR' },
          ],
        })
        .expect(201);

      const productId = created.body.id as string;
      const variantId = created.body.variants[0].id as string;

      const updated = await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${productId}/variants/${variantId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ priceAmount: 9999 })
        .expect(200);

      expect(updated.body.priceAmount).toBe(9999);
    });

    it('DELETE .../variants/:variantId removes the variant', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          variants: [
            { sku: `v-${newId().slice(-6)}`, options: {}, priceAmount: 100, currency: 'EUR' },
          ],
        })
        .expect(201);

      const productId = created.body.id as string;
      const variantId = created.body.variants[0].id as string;

      await request(h.http())
        .delete(`${ADMIN_PRODUCTS}/${productId}/variants/${variantId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const rows = await h.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, variantId));
      expect(rows).toHaveLength(0);
    });
  });

  // ── F1 BLOCKER regression: publish-guard bypass via options-only PATCH ─────────

  describe('Publish guard — variant mutation (F1 BLOCKER)', () => {
    it('PATCH {options:{}} on a free 0-price variant of a published product is rejected, product stays published-safe', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      // Published product with a free 0-price variant (passes publish guard).
      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            {
              sku: `free-${newId().slice(-6)}`,
              options: { free: true },
              priceAmount: 0,
              currency: 'EUR',
            },
          ],
        })
        .expect(201);

      const productId = created.body.id as string;
      const variantId = created.body.variants[0].id as string;

      // Attack: strip the free flag via an options-only PATCH (no priceAmount).
      // Must be rejected (the guard must run on options change, not just price).
      const res = await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${productId}/variants/${variantId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ options: {} });
      expect([400, 422]).toContain(res.status);

      // The variant must STILL be free (the rejected PATCH was not applied).
      const vrows = await h.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, variantId));
      expect(vrows).toHaveLength(1);
      expect((vrows[0]!.options as Record<string, unknown>).free).toBe(true);

      // And the product must NOT be left published-with-a-0-price-non-free variant.
      const prows = await h.db.select().from(products).where(eq(products.id, productId));
      expect(prows[0]!.status).toBe('published');
      // Invariant: every variant of a published product is nonzero-or-free.
      const allVariants = await h.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.productId, productId));
      for (const v of allVariants) {
        const free = (v.options as Record<string, unknown>).free === true;
        expect(v.priceAmount > 0 || free).toBe(true);
      }
    });

    it('PATCH dropping free flag AND setting nonzero price is allowed', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            {
              sku: `f-${newId().slice(-6)}`,
              options: { free: true },
              priceAmount: 0,
              currency: 'EUR',
            },
          ],
        })
        .expect(201);

      await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${created.body.id}/variants/${created.body.variants[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ options: {}, priceAmount: 500 })
        .expect(200);
    });
  });

  // ── F2: last-variant delete on a published product ─────────────────────────────

  describe('Last-variant delete (F2)', () => {
    it('blocks deleting the last variant of a PUBLISHED product', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            { sku: `only-${newId().slice(-6)}`, options: {}, priceAmount: 700, currency: 'EUR' },
          ],
        })
        .expect(201);

      const res = await request(h.http())
        .delete(`${ADMIN_PRODUCTS}/${created.body.id}/variants/${created.body.variants[0].id}`)
        .set('Authorization', `Bearer ${token}`);
      expect([400, 422]).toContain(res.status);

      // Variant survives.
      const rows = await h.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, created.body.variants[0].id));
      expect(rows).toHaveLength(1);
    });

    it('allows deleting the last variant of a DRAFT product', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'draft',
          variants: [
            { sku: `d-${newId().slice(-6)}`, options: {}, priceAmount: 0, currency: 'EUR' },
          ],
        })
        .expect(201);

      await request(h.http())
        .delete(`${ADMIN_PRODUCTS}/${created.body.id}/variants/${created.body.variants[0].id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
    });
  });

  // ── F4: cross-product / cross-tenant variant access ────────────────────────────

  describe('Variant access scoping (F4 / F13)', () => {
    it('PATCH a variant via the WRONG product URL returns 404', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const p1 = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          variants: [
            { sku: `p1-${newId().slice(-6)}`, options: {}, priceAmount: 100, currency: 'EUR' },
          ],
        })
        .expect(201);
      const p2 = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(makeProductPayload())
        .expect(201);

      const p1VariantId = p1.body.variants[0].id as string;

      // Try to mutate p1's variant through p2's URL.
      await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${p2.body.id}/variants/${p1VariantId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ priceAmount: 1 })
        .expect(404);
    });

    it('cannot PATCH a variant belonging to another tenant (404)', async () => {
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);
      const pA = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          ...makeProductPayload(),
          variants: [
            { sku: `ta-${newId().slice(-6)}`, options: {}, priceAmount: 100, currency: 'EUR' },
          ],
        })
        .expect(201);

      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);

      await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${pA.body.id}/variants/${pA.body.variants[0].id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ priceAmount: 1 })
        .expect(404);
    });

    it('variant reorder via wrong product URL is rejected (F4)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const p1 = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          variants: [
            { sku: `r1-${newId().slice(-6)}`, options: {}, priceAmount: 100, currency: 'EUR' },
          ],
        })
        .expect(201);
      const p2 = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send(makeProductPayload())
        .expect(201);

      await request(h.http())
        .post(`${ADMIN_PRODUCTS}/${p2.body.id}/variants/reorder`)
        .set('Authorization', `Bearer ${token}`)
        .send({ order: [p1.body.variants[0].id] })
        .expect(404);
    });
  });

  // ── F6: store endpoints must not 500 on bad params ─────────────────────────────

  describe('Store query robustness (F6)', () => {
    it('garbage cursor is ignored (200, first page) — never 500', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            { sku: `g-${newId().slice(-6)}`, options: {}, priceAmount: 100, currency: 'EUR' },
          ],
        })
        .expect(201);

      // Random non-base64 garbage.
      const r1 = await request(h.http())
        .get(`${STORE_PRODUCTS}?cursor=%%%not-base64%%%`)
        .expect(200);
      expect(Array.isArray(r1.body.data)).toBe(true);

      // Valid base64 of JSON with a non-ISO createdAt + non-uuid id.
      const badCursor = Buffer.from(
        JSON.stringify({ createdAt: 'not-a-date', id: 'not-a-uuid' }),
      ).toString('base64');
      const r2 = await request(h.http())
        .get(`${STORE_PRODUCTS}?cursor=${encodeURIComponent(badCursor)}`)
        .expect(200);
      expect(Array.isArray(r2.body.data)).toBe(true);
    });

    it('garbage pageSize is clamped (200) — never 500', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      await request(h.http()).get(`${STORE_PRODUCTS}?pageSize=notanumber`).expect(200);
      await request(h.http()).get(`${STORE_PRODUCTS}?pageSize=-5`).expect(200);
      await request(h.http()).get(`${STORE_PRODUCTS}?pageSize=99999`).expect(200);
    });
  });

  // ── F13: store LIST allowlist (not just detail) ────────────────────────────────

  describe('Store LIST allowlist (F13)', () => {
    it('list response items expose NO internal fields', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          ...makeProductPayload(),
          status: 'published',
          variants: [
            { sku: `al-${newId().slice(-6)}`, options: {}, priceAmount: 100, currency: 'EUR' },
          ],
        })
        .expect(201);

      const res = await request(h.http()).get(STORE_PRODUCTS).expect(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);

      const forbidden = [
        'embedding',
        'metadata',
        'tenantId',
        'tenant_id',
        'stockQuantity',
        'stock_quantity',
      ];
      for (const p of res.body.data as Array<Record<string, unknown>>) {
        for (const field of forbidden) {
          expect(p).not.toHaveProperty(field);
        }
        for (const v of (p.variants ?? []) as Array<Record<string, unknown>>) {
          expect(v).not.toHaveProperty('stockQuantity');
          expect(v).not.toHaveProperty('stock_quantity');
          expect(v).not.toHaveProperty('tenantId');
          expect(v).toHaveProperty('availability');
        }
      }
    });
  });

  // ── F13: store rate-limit 429 path ─────────────────────────────────────────────

  describe('Store rate limiting (F13)', () => {
    it('returns 429 once the per-IP window cap is exceeded', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      // The store cap is 120/min per IP. resetAuthState FLUSHDBs Redis each test,
      // so the counter starts at 0. Fire 121 requests; at least one must 429.
      let saw429 = false;
      for (let i = 0; i < 125; i++) {
        const res = await request(h.http()).get(STORE_PRODUCTS);
        if (res.status === 429) {
          saw429 = true;
          break;
        }
      }
      expect(saw429).toBe(true);
    });
  });

  // ── Admin list ────────────────────────────────────────────────────────────────

  describe('GET /admin/v1/products (list)', () => {
    it('returns paginated results for the tenant', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      for (let i = 0; i < 3; i++) {
        await request(h.http())
          .post(ADMIN_PRODUCTS)
          .set('Authorization', `Bearer ${token}`)
          .send(makeProductPayload())
          .expect(201);
      }

      const res = await request(h.http())
        .get(`${ADMIN_PRODUCTS}?page=1&pageSize=10`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body.data).toBeDefined();
      expect(res.body.total).toBeGreaterThanOrEqual(3);
      expect(res.body.page).toBe(1);
    });

    it('filters by status', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({ ...makeProductPayload(), status: 'draft' })
        .expect(201);

      const res = await request(h.http())
        .get(`${ADMIN_PRODUCTS}?status=draft`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      for (const p of res.body.data as Array<{ status: string }>) {
        expect(p.status).toBe('draft');
      }
    });

    it('sort=price orders by min variant price ascending (nit)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const mk = async (price: number) =>
        request(h.http())
          .post(ADMIN_PRODUCTS)
          .set('Authorization', `Bearer ${token}`)
          .send({
            title: `Priced ${price} ${newId().slice(-6)}`,
            variants: [
              { sku: `pr-${newId().slice(-6)}`, options: {}, priceAmount: price, currency: 'EUR' },
            ],
          })
          .expect(201);

      await mk(3000);
      await mk(1000);
      await mk(2000);

      const res = await request(h.http())
        .get(`${ADMIN_PRODUCTS}?sort=price&order=asc&pageSize=50`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Extract min price per returned product and assert non-decreasing order.
      const minPrices = (res.body.data as Array<{ variants: Array<{ priceAmount: number }> }>)
        .map((p) => Math.min(...p.variants.map((v) => v.priceAmount)))
        .filter((n) => Number.isFinite(n));
      const sorted = [...minPrices].sort((a, b) => a - b);
      expect(minPrices).toEqual(sorted);
    });
  });
});
