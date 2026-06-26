/**
 * Discount engine integration tests.
 *
 * Full AppModule against real Postgres + Redis (reuses the cart harness). Covers:
 *  - Admin CRUD (create / list / get / update / delete), permission-gated (401/403)
 *  - Store apply-by-code on a cart (valid → totals reflect discount; ineligible → 422;
 *    remove → reverts)
 *  - Automatic (null-code) discount applied without a code
 *  - Cart totals recompute on item change with a discount active
 *  - Tenant isolation (a discount in another tenant is invisible)
 */
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import {
  bootCartApp,
  resetCartState,
  seedProductWithVariants,
  seedCategoryForProduct,
  seedAdminAndLogin,
  seedDiscount,
  extractCartTokenCookie,
  CartHarness,
  DEFAULT_TENANT_ID,
  newId,
} from '../cart/_cart-harness';
import { discounts } from '../../../src/database/schema/discounts';

let h: CartHarness;

beforeAll(async () => {
  h = await bootCartApp();
}, 30_000);

afterAll(async () => {
  await h.app.close();
  await h.client.end();
});

beforeEach(async () => {
  await resetCartState(h);
}, 10_000);

const ADMIN = '/admin/v1/discounts';

// ── helpers ──────────────────────────────────────────────────────────────────

async function createCartWithItem(): Promise<{
  cartId: string;
  cartCookie: string;
  variantId: string;
  productId: string;
}> {
  const { variantId, productId } = await seedProductWithVariants(h); // variant A = 1000
  const cartRes = await request(h.http()).post('/store/v1/carts').send({});
  const cartId = cartRes.body.cartId as string;
  const cartCookie = extractCartTokenCookie(cartRes);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cartCookie)
    .send({ variantId, quantity: 2 }) // subtotal 2000
    .expect(201);
  return { cartId, cartCookie, variantId, productId };
}

// ── ADMIN CRUD + permission gating ────────────────────────────────────────────

describe('Admin /admin/v1/discounts', () => {
  it('rejects unauthenticated requests with 401', async () => {
    await request(h.http()).get(ADMIN).expect(401);
    await request(h.http()).post(ADMIN).send({ name: 'X', type: 'percentage', value: 1000 }).expect(401); // prettier-ignore
  });

  it('rejects a staff role (no settings:write) with 403', async () => {
    const staff = await seedAdminAndLogin(h, 'staff');
    await request(h.http())
      .post(ADMIN)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .send({ name: 'Staff try', type: 'percentage', value: 1000 })
      .expect(403);
  });

  it('creates, lists, gets, updates and deletes a discount', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const auth = { Authorization: `Bearer ${admin.accessToken}` };

    const created = await request(h.http())
      .post(ADMIN)
      .set(auth)
      .send({ name: 'Spring Sale', code: 'SPRING10', type: 'percentage', value: 1000 })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.name).toBe('Spring Sale');
    expect(created.body.code).toBe('SPRING10');

    const list = await request(h.http()).get(ADMIN).set(auth).expect(200);
    expect(list.body).toHaveLength(1);

    const got = await request(h.http()).get(`${ADMIN}/${id}`).set(auth).expect(200);
    expect(got.body.value).toBe(1000);

    const updated = await request(h.http())
      .patch(`${ADMIN}/${id}`)
      .set(auth)
      .send({ value: 2500, active: false })
      .expect(200);
    expect(updated.body.value).toBe(2500);
    expect(updated.body.active).toBe(false);

    await request(h.http()).delete(`${ADMIN}/${id}`).set(auth).expect(204);
    await request(h.http()).get(`${ADMIN}/${id}`).set(auth).expect(404);
  });

  it('rejects a percentage value above 10000 (>100%) with 400 (DTO validation)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(ADMIN)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ name: 'Too big', type: 'percentage', value: 10001 })
      .expect(400);
  });

  it('requires targetIds for a products-scope discount (400 DTO validation)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(ADMIN)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ name: 'Scoped', type: 'fixed', value: 500, appliesTo: 'products' })
      .expect(400);
  });
});

// ── STORE apply-by-code ───────────────────────────────────────────────────────

describe('POST /store/v1/carts/:cartId/discounts', () => {
  it('applies a valid percentage code and reflects it in totals', async () => {
    await seedDiscount(h, { code: 'SAVE10', value: 1000, type: 'percentage' }); // 10%
    const { cartId, cartCookie } = await createCartWithItem(); // subtotal 2000

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/discounts`)
      .set('Cookie', cartCookie)
      .send({ code: 'SAVE10' })
      .expect(200);

    expect(res.body.totals.subtotal).toBe(2000);
    expect(res.body.totals.discountTotal).toBe(200);
    expect(res.body.totals.grandTotal).toBe(1800);
  });

  it('applies a valid fixed code clamped to subtotal', async () => {
    await seedDiscount(h, { code: 'TENOFF', type: 'fixed', value: 500, currency: 'EUR' });
    const { cartId, cartCookie } = await createCartWithItem(); // subtotal 2000
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/discounts`)
      .set('Cookie', cartCookie)
      .send({ code: 'TENOFF' })
      .expect(200);
    expect(res.body.totals.discountTotal).toBe(500);
    expect(res.body.totals.grandTotal).toBe(1500);
  });

  it('returns 422 for an unknown code', async () => {
    const { cartId, cartCookie } = await createCartWithItem();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/discounts`)
      .set('Cookie', cartCookie)
      .send({ code: 'NOPE' })
      .expect(422);
  });

  it('returns 422 for an ineligible code (min_cart not met)', async () => {
    await seedDiscount(h, { code: 'BIG', value: 1000, min_cart_amount: 5000 });
    const { cartId, cartCookie } = await createCartWithItem(); // subtotal 2000 < 5000
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/discounts`)
      .set('Cookie', cartCookie)
      .send({ code: 'BIG' })
      .expect(422);
  });

  it('removing the code reverts the totals', async () => {
    await seedDiscount(h, { code: 'SAVE10', value: 1000 });
    const { cartId, cartCookie } = await createCartWithItem();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/discounts`)
      .set('Cookie', cartCookie)
      .send({ code: 'SAVE10' })
      .expect(200);

    const removed = await request(h.http())
      .delete(`/store/v1/carts/${cartId}/discounts/SAVE10`)
      .set('Cookie', cartCookie)
      .expect(200);
    expect(removed.body.totals.discountTotal).toBe(0);
    expect(removed.body.totals.grandTotal).toBe(2000);
  });

  it('writes an audit row on apply', async () => {
    await seedDiscount(h, { code: 'SAVE10', value: 1000 });
    const { cartId, cartCookie } = await createCartWithItem();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/discounts`)
      .set('Cookie', cartCookie)
      .send({ code: 'SAVE10' })
      .expect(200);
    const rows = await h.client`
      select action from audit_log where action = 'cart.discount_applied'
    `;
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ── AUTOMATIC discount (null code) ────────────────────────────────────────────

describe('automatic discounts', () => {
  it('applies an active null-code discount without any apply call', async () => {
    await seedDiscount(h, { code: null, value: 2000, type: 'percentage' }); // 20% automatic
    const { variantId } = await seedProductWithVariants(h);
    const cartRes = await request(h.http()).post('/store/v1/carts').send({});
    const cartId = cartRes.body.cartId as string;
    const cartCookie = extractCartTokenCookie(cartRes);

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 }) // subtotal 1000
      .expect(201);

    expect(res.body.totals.subtotal).toBe(1000);
    expect(res.body.totals.discountTotal).toBe(200); // 20% automatic
    expect(res.body.totals.grandTotal).toBe(800);
  });

  it('stacks a stackable automatic with a stackable explicit code', async () => {
    await seedDiscount(h, { code: null, value: 1000, stackable: true }); // 10% auto
    await seedDiscount(h, { code: 'EXTRA', value: 1000, stackable: true }); // 10% code
    const { cartId, cartCookie } = await createCartWithItem(); // subtotal 2000

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/discounts`)
      .set('Cookie', cartCookie)
      .send({ code: 'EXTRA' })
      .expect(200);
    // Both apply to the ORIGINAL base (non-compounding): 200 + 200 = 400.
    expect(res.body.totals.discountTotal).toBe(400);
    expect(res.body.totals.grandTotal).toBe(1600);
  });
});

// ── recompute on item change ──────────────────────────────────────────────────

describe('recompute with an active discount', () => {
  it('updates discountTotal when the cart subtotal changes', async () => {
    await seedDiscount(h, { code: 'SAVE10', value: 1000 });
    const { cartId, cartCookie, variantId } = await createCartWithItem(); // subtotal 2000

    const applied = await request(h.http())
      .post(`/store/v1/carts/${cartId}/discounts`)
      .set('Cookie', cartCookie)
      .send({ code: 'SAVE10' })
      .expect(200);
    expect(applied.body.totals.discountTotal).toBe(200);

    // Find the item id, bump qty 2 → 4 (subtotal 4000) and assert the discount scales.
    const itemId = applied.body.items[0].id as string;
    const bumped = await request(h.http())
      .patch(`/store/v1/carts/${cartId}/items/${itemId}`)
      .set('Cookie', cartCookie)
      .send({ quantity: 4 })
      .expect(200);
    expect(bumped.body.totals.subtotal).toBe(4000);
    expect(bumped.body.totals.discountTotal).toBe(400); // 10% of 4000
    expect(bumped.body.totals.grandTotal).toBe(3600);
    void variantId;
  });

  it('a categories-scope discount applies only to in-category lines', async () => {
    const { variantId, productId } = await seedProductWithVariants(h);
    const categoryId = await seedCategoryForProduct(h, productId);
    await seedDiscount(h, {
      code: 'CAT20',
      value: 2000,
      type: 'percentage',
      applies_to: 'categories',
      target_ids: [categoryId],
    });
    const cartRes = await request(h.http()).post('/store/v1/carts').send({});
    const cartId = cartRes.body.cartId as string;
    const cartCookie = extractCartTokenCookie(cartRes);
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 }) // 1000, in category
      .expect(201);

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/discounts`)
      .set('Cookie', cartCookie)
      .send({ code: 'CAT20' })
      .expect(200);
    expect(res.body.totals.discountTotal).toBe(200); // 20% of 1000
  });
});

// ── tenant isolation ──────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('a discount in another tenant is invisible to this storefront', async () => {
    // Seed a discount under a DIFFERENT tenant directly.
    const otherTenant = newId();
    await h.client`insert into tenants (id, name, slug) values (${otherTenant}, ${'Other'}, ${`other-${otherTenant.slice(0, 8)}`})`; // prettier-ignore
    const otherDiscountId = newId();
    await h.client`
      insert into discounts (id, tenant_id, code, name, type, value, applies_to, active)
      values (${otherDiscountId}, ${otherTenant}, ${'FOREIGN'}, ${'Foreign'}, ${'percentage'}, ${5000}, ${'all'}, true)
    `;

    const { cartId, cartCookie } = await createCartWithItem();
    // The default-tenant storefront must NOT resolve the other tenant's code → 422.
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/discounts`)
      .set('Cookie', cartCookie)
      .send({ code: 'FOREIGN' })
      .expect(422);

    // And the row still belongs to the other tenant only.
    const here = await h.db
      .select()
      .from(discounts)
      .where(and(eq(discounts.tenantId, DEFAULT_TENANT_ID), eq(discounts.code, 'FOREIGN')));
    expect(here).toHaveLength(0);
  });
});
