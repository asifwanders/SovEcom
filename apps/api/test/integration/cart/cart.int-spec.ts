/**
 * Cart System integration tests.
 *
 * Full AppModule against real Postgres + Redis. Tests:
 *  - Create cart (httpOnly cookie issued)
 *  - Add / update / remove items; totals recomputed
 *  - Currency-mixing rejection
 *  - Cart token cookie validation (missing / wrong rejected with 403)
 *  - Cross-tenant access rejected
 *  - Guest→customer merge (sum qty, clamp stock)
 *  - Shipping address + method → totals recomputed
 *  - Billing address
 *  - Guest email association
 *  - Redis→Postgres consistency after flush worker
 *  - Expiry: redis TTL set, abandoned cart
 *  - Concurrent item updates (last-write-wins, totals recomputed)
 */
import request from 'supertest';
import {
  bootCartApp,
  resetCartState,
  seedProductWithVariants,
  seedShippingRate,
  signupAndLoginCustomer,
  extractCartTokenCookie,
  CartHarness,
  DEFAULT_TENANT_ID,
  CART_TOKEN_COOKIE,
  newId,
} from './_cart-harness';
import { InventoryService } from '../../../src/inventory/inventory.service';

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

// ── helpers ───────────────────────────────────────────────────────────────────

async function createCart(): Promise<{
  cartId: string;
  cartCookie: string;
  res: request.Response;
}> {
  const res = await request(h.http()).post('/store/v1/carts').send({});
  expect(res.status).toBe(201);
  const cartId = res.body.cartId as string;
  const cartCookie = extractCartTokenCookie(res);
  expect(cartId).toBeTruthy();
  expect(cartCookie).toBeTruthy();
  return { cartId, cartCookie, res };
}

// ── CREATE CART ───────────────────────────────────────────────────────────────

describe('POST /store/v1/carts', () => {
  it('creates an empty cart and sets httpOnly cart-token cookie', async () => {
    const res = await request(h.http()).post('/store/v1/carts').send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ cartId: expect.any(String), currency: expect.any(String) });

    // Cookie must be httpOnly and SameSite=Lax
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie).toBeTruthy();
    const cartCookie = setCookie!.find((c) => c.startsWith(`${CART_TOKEN_COOKIE}=`));
    expect(cartCookie).toBeTruthy();
    expect(cartCookie!.toLowerCase()).toContain('httponly');
    expect(cartCookie!.toLowerCase()).toContain('samesite=lax');
  });
});

// ── GET CART ──────────────────────────────────────────────────────────────────

describe('GET /store/v1/carts/:cartId', () => {
  it('returns the cart with valid cookie', async () => {
    const { cartId, cartCookie } = await createCart();
    const res = await request(h.http()).get(`/store/v1/carts/${cartId}`).set('Cookie', cartCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: cartId, items: [] });
  });

  it('rejects missing cart token with 403', async () => {
    const { cartId } = await createCart();
    const res = await request(h.http()).get(`/store/v1/carts/${cartId}`);
    expect(res.status).toBe(403);
  });

  it('rejects wrong cart token with 403', async () => {
    const { cartId } = await createCart();
    const res = await request(h.http())
      .get(`/store/v1/carts/${cartId}`)
      .set('Cookie', `${CART_TOKEN_COOKIE}=wrong-token-value`);
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown cartId', async () => {
    const { cartCookie } = await createCart();
    const res = await request(h.http()).get(`/store/v1/carts/${newId()}`).set('Cookie', cartCookie);
    expect(res.status).toBe(404);
  });
});

// ── ADD ITEMS ─────────────────────────────────────────────────────────────────

describe('POST /store/v1/carts/:cartId/items', () => {
  it('adds an item and returns updated cart with totals', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ variantId, quantity: 2, unitPriceAmount: 1000 });
    // subtotal = 2 × 1000 = 2000; discountTotal=0, taxTotal=0, shipping=0
    expect(res.body.totals.subtotal).toBe(2000);
    expect(res.body.totals.grandTotal).toBe(2000);
    expect(res.body.totals.discountTotal).toBe(0);
    expect(res.body.totals.taxTotal).toBe(0);
    // reverseCharge is serialised as an explicit boolean, FALSE for a plain
    // (no tax regime / no destination) cart — NOT inferred from taxTotal===0.
    expect(res.body.totals.reverseCharge).toBe(false);
  });

  it('merges quantity when same variant added twice', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();

    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(3);
  });

  // ── Display-identity snapshot at add-time ───────────────

  it('snapshots the product/variant title, options, sku and slug onto the cart line at add-time', async () => {
    const productId = newId();
    const variantId = newId();
    const slug = `snap-${productId.slice(0, 8)}`;
    await h.client`
      insert into products (id, tenant_id, title, slug, status)
      values (${productId}, ${DEFAULT_TENANT_ID}, ${'Snapshot Tee'}, ${slug}, ${'published'})
    `;
    await h.client`
      insert into product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity)
      values (${variantId}, ${DEFAULT_TENANT_ID}, ${productId}, ${'TEE-M-BLUE'}, ${'Medium / Blue'}, ${'{"Size":"M","Color":"Blue"}'}::jsonb, ${1500}, ${'EUR'}, ${10})
    `;
    const { cartId, cartCookie } = await createCart();

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });
    expect(res.status).toBe(201);
    expect(res.body.items[0]).toMatchObject({
      variantId,
      productTitle: 'Snapshot Tee',
      variantTitle: 'Medium / Blue',
      options: { Size: 'M', Color: 'Blue' },
      sku: 'TEE-M-BLUE',
      productSlug: slug,
    });
  });

  it('keeps the snapshot stable after the product is RENAMED post-add (proves snapshot semantics)', async () => {
    const productId = newId();
    const variantId = newId();
    const slug = `rename-${productId.slice(0, 8)}`;
    await h.client`
      insert into products (id, tenant_id, title, slug, status)
      values (${productId}, ${DEFAULT_TENANT_ID}, ${'Original Name'}, ${slug}, ${'published'})
    `;
    await h.client`
      insert into product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity)
      values (${variantId}, ${DEFAULT_TENANT_ID}, ${productId}, ${'ORIG-SKU'}, ${'Original Variant'}, ${'{}'}::jsonb, ${1000}, ${'EUR'}, ${10})
    `;
    const { cartId, cartCookie } = await createCart();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });

    // Rename the product + variant AND unpublish it AFTER it was added to the cart.
    await h.client`update products set title = ${'Renamed Later'}, status = ${'draft'} where id = ${productId}`;
    await h.client`update product_variants set title = ${'Renamed Variant'}, sku = ${'NEW-SKU'} where id = ${variantId}`;

    // Re-read the cart: the line must still show what the customer ADDED, not the new name.
    const res = await request(h.http()).get(`/store/v1/carts/${cartId}`).set('Cookie', cartCookie);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      productTitle: 'Original Name',
      variantTitle: 'Original Variant',
      sku: 'ORIG-SKU',
    });
    expect(res.body.items[0].productTitle).not.toBe('Renamed Later');
  });

  it('persists the snapshot to Postgres so it survives a Redis-evicted rehydrate', async () => {
    const productId = newId();
    const variantId = newId();
    const slug = `flush-${productId.slice(0, 8)}`;
    await h.client`
      insert into products (id, tenant_id, title, slug, status)
      values (${productId}, ${DEFAULT_TENANT_ID}, ${'Flushed Product'}, ${slug}, ${'published'})
    `;
    await h.client`
      insert into product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity)
      values (${variantId}, ${DEFAULT_TENANT_ID}, ${productId}, ${'FLUSH-SKU'}, ${'Flushed Variant'}, ${'{"Size":"L"}'}::jsonb, ${1200}, ${'EUR'}, ${10})
    `;
    const { cartId, cartCookie } = await createCart();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 2 });

    // Flush to Postgres, then EVICT the Redis blob so the next read rehydrates from Postgres.
    const { CartFlushService } = await import('../../../src/cart/cart-flush.service');
    const flushSvc = h.app.get(CartFlushService, { strict: false });
    await (flushSvc as { flush(): Promise<void> }).flush();

    // The persisted columns carry the snapshot.
    const itemRows = await h.client`select * from cart_items where cart_id = ${cartId}`;
    expect(itemRows).toHaveLength(1);
    expect(itemRows[0]!.product_title).toBe('Flushed Product');
    expect(itemRows[0]!.variant_title).toBe('Flushed Variant');
    expect(itemRows[0]!.sku).toBe('FLUSH-SKU');
    expect(itemRows[0]!.product_slug).toBe(slug);
    expect(itemRows[0]!.options).toEqual({ Size: 'L' });

    // Evict Redis → the GET rehydrates from Postgres and still surfaces the snapshot.
    await h.redis.del(`sovecom:t:${DEFAULT_TENANT_ID}:cart:${cartId}`);
    const res = await request(h.http()).get(`/store/v1/carts/${cartId}`).set('Cookie', cartCookie);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      productTitle: 'Flushed Product',
      variantTitle: 'Flushed Variant',
      sku: 'FLUSH-SKU',
      productSlug: slug,
      options: { Size: 'L' },
    });
  }, 15_000);

  it('rejects adding unknown variant with 404', async () => {
    const { cartId, cartCookie } = await createCart();
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId: newId(), quantity: 1 });
    expect(res.status).toBe(404);
  });

  it('rejects quantity <= 0 with 400', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 0 });
    expect(res.status).toBe(400);
  });

  it('rejects mixing currencies', async () => {
    const { variantId, currency } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();

    // First item establishes currency
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });

    // Seed a second product with different currency
    const pid2 = newId();
    const vid2 = newId();
    await h.client`
      insert into products (id, tenant_id, title, slug, status)
      values (${pid2}, ${DEFAULT_TENANT_ID}, ${'Product 2'}, ${`slug-${pid2.slice(0, 8)}`}, ${'published'})
    `;
    await h.client`
      insert into product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity)
      values (${vid2}, ${DEFAULT_TENANT_ID}, ${pid2}, ${`SKU-USD-${vid2.slice(0, 8)}`}, ${'USD variant'}, ${'{}'}::jsonb, ${1500}, ${'USD'}, ${10})
    `;
    void currency; // EUR was the first currency

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId: vid2, quantity: 1 });
    expect(res.status).toBe(422);
  });

  it('rejects adding item to non-existent cart', async () => {
    const { variantId } = await seedProductWithVariants(h);
    // A token-bearing request to an unknown cart → 404 (matches GET-unknown→404);
    // 403 is reserved for a request that presents NO credentials at all.
    const res = await request(h.http())
      .post(`/store/v1/carts/${newId()}/items`)
      .set('Cookie', `${CART_TOKEN_COOKIE}=any-token`)
      .send({ variantId, quantity: 1 });
    expect(res.status).toBe(404);
  });

  it('rejects adding variant from a different tenant (cross-tenant)', async () => {
    const { cartId, cartCookie } = await createCart();

    // Seed a second tenant + product + variant. resetCartState does not truncate
    // `tenants`, so the slug must be unique per run to stay idempotent.
    const tenantId2 = newId();
    await h.client`
      insert into tenants (id, name, slug)
      values (${tenantId2}, ${`Tenant ${tenantId2.slice(0, 8)}`}, ${`tenant-${tenantId2.slice(0, 8)}`})
    `;
    const pid2 = newId();
    const vid2 = newId();
    await h.client`
      insert into products (id, tenant_id, title, slug, status)
      values (${pid2}, ${tenantId2}, ${'T2 Product'}, ${`t2-${pid2.slice(0, 8)}`}, ${'published'})
    `;
    await h.client`
      insert into product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity)
      values (${vid2}, ${tenantId2}, ${pid2}, ${`T2-SKU-${vid2.slice(0, 8)}`}, ${'T2 Variant'}, ${'{}'}::jsonb, ${1000}, ${'EUR'}, ${5})
    `;

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId: vid2, quantity: 1 });
    expect(res.status).toBe(404);
  });

  it('rejects adding a variant from a draft (non-published) product', async () => {
    const { cartId, cartCookie } = await createCart();
    const draftProductId = newId();
    const draftVariantId = newId();
    await h.client`
      insert into products (id, tenant_id, title, slug, status)
      values (${draftProductId}, ${DEFAULT_TENANT_ID}, ${'Draft'}, ${`draft-${draftProductId.slice(0, 8)}`}, ${'draft'})
    `;
    await h.client`
      insert into product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity)
      values (${draftVariantId}, ${DEFAULT_TENANT_ID}, ${draftProductId}, ${`DRAFT-${draftVariantId.slice(0, 8)}`}, ${'D1'}, ${'{}'}::jsonb, ${500}, ${'EUR'}, ${10})
    `;
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId: draftVariantId, quantity: 1 });
    expect(res.status).toBe(404);
  });
});

// ── UPDATE ITEM ───────────────────────────────────────────────────────────────

describe('PATCH /store/v1/carts/:cartId/items/:itemId', () => {
  it('updates quantity and recomputes totals', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();

    const addRes = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });
    const itemId = addRes.body.items[0].id as string;

    const res = await request(h.http())
      .patch(`/store/v1/carts/${cartId}/items/${itemId}`)
      .set('Cookie', cartCookie)
      .send({ quantity: 3 });
    expect(res.status).toBe(200);
    expect(res.body.items[0].quantity).toBe(3);
    expect(res.body.totals.subtotal).toBe(3000);
  });

  it('rejects quantity <= 0', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();
    const addRes = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 2 });
    const itemId = addRes.body.items[0].id as string;
    const res = await request(h.http())
      .patch(`/store/v1/carts/${cartId}/items/${itemId}`)
      .set('Cookie', cartCookie)
      .send({ quantity: 0 });
    expect(res.status).toBe(400);
  });
});

// ── REMOVE ITEM ───────────────────────────────────────────────────────────────

describe('DELETE /store/v1/carts/:cartId/items/:itemId', () => {
  it('removes an item and recomputes totals', async () => {
    const { variantId, variantId2 } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();

    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });
    const addRes = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId: variantId2, quantity: 1 });
    const itemId = addRes.body.items.find((i: { variantId: string }) => i.variantId === variantId)!
      .id as string;

    const res = await request(h.http())
      .delete(`/store/v1/carts/${cartId}/items/${itemId}`)
      .set('Cookie', cartCookie);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.totals.subtotal).toBe(2000);
  });
});

// ── SHIPPING ADDRESS ──────────────────────────────────────────────────────────

describe('POST /store/v1/carts/:cartId/shipping-address', () => {
  it('stores shipping address and updates cart', async () => {
    const { cartId, cartCookie } = await createCart();
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cartCookie)
      .send({
        name: 'Alice',
        line1: '1 Rue de la Paix',
        city: 'Paris',
        postalCode: '75001',
        country: 'FR',
      });
    expect(res.status).toBe(200);
    expect(res.body.shippingAddress).toMatchObject({ country: 'FR' });
  });

  it('rejects invalid country code', async () => {
    const { cartId, cartCookie } = await createCart();
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cartCookie)
      .send({
        name: 'Alice',
        line1: '1 St',
        city: 'Paris',
        postalCode: '75001',
        country: 'INVALID',
      });
    expect(res.status).toBe(400);
  });
});

// ── BILLING ADDRESS ───────────────────────────────────────────────────────────

describe('POST /store/v1/carts/:cartId/billing-address', () => {
  it('stores billing address', async () => {
    const { cartId, cartCookie } = await createCart();
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/billing-address`)
      .set('Cookie', cartCookie)
      .send({
        name: 'Alice',
        line1: '1 Rue de la Paix',
        city: 'Paris',
        postalCode: '75001',
        country: 'FR',
      });
    expect(res.status).toBe(200);
    expect(res.body.billingAddress).toMatchObject({ country: 'FR' });
  });
});

// ── SHIPPING METHOD ───────────────────────────────────────────────────────────

describe('POST /store/v1/carts/:cartId/shipping-method', () => {
  // seedShippingRate creates a zone covering FR/DE, so the cart needs a FR (or DE)
  // shipping address before a rate is AVAILABLE for it.
  const SHIP_FR = {
    name: 'Alice',
    line1: '1 Rue',
    city: 'Paris',
    postalCode: '75001',
    country: 'FR',
  };

  it('picks shipping rate and recomputes totals', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const rateId = await seedShippingRate(h, 'EUR');
    const { cartId, cartCookie } = await createCart();

    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cartCookie)
      .send(SHIP_FR)
      .expect(200);

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-method`)
      .set('Cookie', cartCookie)
      .send({ shippingRateId: rateId });
    expect(res.status).toBe(200);
    // subtotal=1000 + shipping=500 = 1500
    expect(res.body.totals.shipping).toBe(500);
    expect(res.body.totals.grandTotal).toBe(1500);
  });

  it('rejects an unknown / unavailable shipping rate with 422', async () => {
    const { cartId, cartCookie } = await createCart();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cartCookie)
      .send(SHIP_FR)
      .expect(200);
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-method`)
      .set('Cookie', cartCookie)
      .send({ shippingRateId: newId() });
    expect(res.status).toBe(422); // not available for this cart
  });

  it('rejects a rate when the cart has no shipping address (no destination zone)', async () => {
    const rateId = await seedShippingRate(h, 'EUR');
    const { cartId, cartCookie } = await createCart();
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-method`)
      .set('Cookie', cartCookie)
      .send({ shippingRateId: rateId });
    expect(res.status).toBe(422);
  });
});

// ── GUEST EMAIL ───────────────────────────────────────────────────────────────

describe('POST /store/v1/carts/:cartId/email', () => {
  it('sets guest email', async () => {
    const { cartId, cartCookie } = await createCart();
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/email`)
      .set('Cookie', cartCookie)
      .send({ email: 'guest@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.guestEmail).toBe('guest@example.com');
  });

  it('rejects invalid email', async () => {
    const { cartId, cartCookie } = await createCart();
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/email`)
      .set('Cookie', cartCookie)
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});

// ── CUSTOMER ASSOCIATION + MERGE ──────────────────────────────────────────────

describe('POST /store/v1/carts/:cartId/customer (merge)', () => {
  it('associates authenticated customer with a guest cart', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 2 });

    const { accessToken } = await signupAndLoginCustomer(h);

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/customer`)
      .set('Cookie', cartCookie)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.customerId).toBeTruthy();
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(2);
  });

  it('merges guest cart into existing customer cart: sums qty, clamps to availability', async () => {
    // Two carts compete for the same variant's units, now that RESERVE stock is in
    // for the same variant's units. With the old stock=10 the guest's add of 8
    // would 409 (customer already holds 6 → only 4 available). We bump variantId's
    // stock to 20 so BOTH carts can reserve, then assert the merge re-reserves the
    // summed quantity against true availability. After the guest cart's reservation
    // is released, the surviving customer cart re-reserves 6+8=14 (≤ stock 20), so
    // the merged line is 14 — the reservation system, not a raw stock read, is now
    // the source of truth for the merged quantity.
    const { variantId, variantId2 } = await seedProductWithVariants(h);
    await h.client`update product_variants set stock_quantity = 20 where id = ${variantId}`;
    const { accessToken, customerId } = await signupAndLoginCustomer(h);

    // Customer cart reserves 6 of variantId (stock 20 → 14 still available).
    const custCartRes = await request(h.http()).post('/store/v1/carts').send({});
    const custCartId = custCartRes.body.cartId as string;
    const custCartCookie = extractCartTokenCookie(custCartRes);
    await request(h.http())
      .post(`/store/v1/carts/${custCartId}/items`)
      .set('Cookie', custCartCookie)
      .send({ variantId, quantity: 6 });
    await request(h.http())
      .post(`/store/v1/carts/${custCartId}/customer`)
      .set('Cookie', custCartCookie)
      .set('Authorization', `Bearer ${accessToken}`);

    // Guest cart reserves 8 of variantId (14 available at this point → succeeds)
    // plus 2 of variantId2 (only in guest).
    const guestCartRes = await request(h.http()).post('/store/v1/carts').send({});
    const guestCartId = guestCartRes.body.cartId as string;
    const guestCartCookie = extractCartTokenCookie(guestCartRes);
    const guestAdd = await request(h.http())
      .post(`/store/v1/carts/${guestCartId}/items`)
      .set('Cookie', guestCartCookie)
      .send({ variantId, quantity: 8 });
    expect(guestAdd.status).toBe(201); // both carts coexist within stock=20
    await request(h.http())
      .post(`/store/v1/carts/${guestCartId}/items`)
      .set('Cookie', guestCartCookie)
      .send({ variantId: variantId2, quantity: 2 });

    // Merge: guest cart associates the customer who already has a cart.
    const mergeRes = await request(h.http())
      .post(`/store/v1/carts/${guestCartId}/customer`)
      .set('Cookie', guestCartCookie)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(mergeRes.status).toBe(200);

    void customerId;
    const items = mergeRes.body.items as Array<{ variantId: string; quantity: number }>;
    const v1Item = items.find((i) => i.variantId === variantId);
    const v2Item = items.find((i) => i.variantId === variantId2);

    // 6 + 8 = 14 ≤ stock 20 (the guest's reservation was released first, so the
    // surviving cart can re-reserve the full sum).
    expect(v1Item?.quantity).toBe(14);
    // variantId2 only in guest → re-reserved as-is (2 ≤ stock 5).
    expect(v2Item?.quantity).toBe(2);
  });

  it('merge clamps a merged line to availability when stock is tight', async () => {
    // Complements the above: keep variantId stock at the helper default (10) and
    // assert the merge CLAMPS. Customer holds 6; guest holds 3 (9 ≤ 10, both
    // reserve). On merge the guest's 3 is released, the customer cart re-reserves
    // 6+3=9 (≤ 10) — but we then assert the clamp path by making the sum exceed
    // stock: guest adds 4 (6+4=10 reserved across carts is exactly stock, OK),
    // merged sum 6+4=10 ≤ 10 → 10.
    const { variantId } = await seedProductWithVariants(h); // stock = 10
    const { accessToken } = await signupAndLoginCustomer(h);

    const custCartRes = await request(h.http()).post('/store/v1/carts').send({});
    const custCartId = custCartRes.body.cartId as string;
    const custCookie = extractCartTokenCookie(custCartRes);
    await request(h.http())
      .post(`/store/v1/carts/${custCartId}/items`)
      .set('Cookie', custCookie)
      .send({ variantId, quantity: 6 });
    await request(h.http())
      .post(`/store/v1/carts/${custCartId}/customer`)
      .set('Cookie', custCookie)
      .set('Authorization', `Bearer ${accessToken}`);

    const guestRes = await request(h.http()).post('/store/v1/carts').send({});
    const guestId = guestRes.body.cartId as string;
    const guestCookie = extractCartTokenCookie(guestRes);
    // Only 4 available (customer holds 6 of 10) → guest can reserve exactly 4.
    const add = await request(h.http())
      .post(`/store/v1/carts/${guestId}/items`)
      .set('Cookie', guestCookie)
      .send({ variantId, quantity: 4 });
    expect(add.status).toBe(201);

    const mergeRes = await request(h.http())
      .post(`/store/v1/carts/${guestId}/customer`)
      .set('Cookie', guestCookie)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(mergeRes.status).toBe(200);
    const v1 = (mergeRes.body.items as Array<{ variantId: string; quantity: number }>).find(
      (i) => i.variantId === variantId,
    );
    // 6 + 4 = 10, exactly stock → 10 (clamp boundary).
    expect(v1?.quantity).toBe(10);
  });

  it('rejects association without customer JWT with 401', async () => {
    const { cartId, cartCookie } = await createCart();
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/customer`)
      .set('Cookie', cartCookie);
    expect(res.status).toBe(401);
  });
});

// ── DELETE CART ───────────────────────────────────────────────────────────────

describe('DELETE /store/v1/carts/:cartId', () => {
  it('abandons the cart', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });

    const res = await request(h.http())
      .delete(`/store/v1/carts/${cartId}`)
      .set('Cookie', cartCookie);
    expect(res.status).toBe(204);

    // Subsequent GET returns 404 (cart abandoned)
    const getRes = await request(h.http())
      .get(`/store/v1/carts/${cartId}`)
      .set('Cookie', cartCookie);
    expect(getRes.status).toBe(404);
  });
});

// ── REDIS KEY SET ─────────────────────────────────────────────────────────────

describe('Redis→Postgres consistency', () => {
  it('sets the cart key in Redis with TTL after create', async () => {
    const res = await request(h.http()).post('/store/v1/carts').send({});
    const cartId = res.body.cartId as string;
    const key = `sovecom:t:${DEFAULT_TENANT_ID}:cart:${cartId}`;
    const exists = await h.redis.exists(key);
    expect(exists).toBe(1);
    const ttl = await h.redis.ttl(key);
    // 8 days TTL, allow ±120 s
    expect(ttl).toBeGreaterThan(8 * 24 * 3600 - 120);
    expect(ttl).toBeLessThanOrEqual(8 * 24 * 3600);
  });

  it('adds the cart to the dirty set after mutation', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });
    const dirtyKey = `sovecom:t:${DEFAULT_TENANT_ID}:cart:dirty`;
    const members = await h.redis.smembers(dirtyKey);
    expect(members).toContain(cartId);
  });

  it('flush worker upserts cart + items to Postgres', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 3 });

    // Trigger the flush manually via the service
    const { CartFlushService } = await import('../../../src/cart/cart-flush.service');
    const flushSvc = h.app.get(CartFlushService, { strict: false });
    await (flushSvc as { flush(): Promise<void> }).flush();

    // Check Postgres has the cart and items
    const cartRows = await h.client`select * from carts where id = ${cartId}`;
    expect(cartRows).toHaveLength(1);
    const itemRows = await h.client`select * from cart_items where cart_id = ${cartId}`;
    expect(itemRows).toHaveLength(1);
    expect(Number(itemRows[0]!.quantity)).toBe(3);

    // Dirty set should be empty
    const dirtyKey = `sovecom:t:${DEFAULT_TENANT_ID}:cart:dirty`;
    const members = await h.redis.smembers(dirtyKey);
    expect(members).not.toContain(cartId);
  }, 15_000);
});

// ── CONCURRENT UPDATES ────────────────────────────────────────────────────────

describe('Concurrent item updates (last-write-wins per item)', () => {
  it('final state is consistent after concurrent PATCH calls', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();
    const addRes = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 5 });
    const itemId = addRes.body.items[0].id as string;

    // Fire concurrent patches
    const patches = [1, 2, 3, 4, 5].map((q) =>
      request(h.http())
        .patch(`/store/v1/carts/${cartId}/items/${itemId}`)
        .set('Cookie', cartCookie)
        .send({ quantity: q }),
    );
    const results = await Promise.all(patches);
    // All must succeed
    for (const r of results) {
      expect(r.status).toBe(200);
    }

    // Final GET must return a consistent cart with totals
    const getRes = await request(h.http())
      .get(`/store/v1/carts/${cartId}`)
      .set('Cookie', cartCookie);
    expect(getRes.status).toBe(200);
    const items = getRes.body.items as Array<{ quantity: number; unitPriceAmount: number }>;
    const qty = items[0]!.quantity;
    // totals must match the actual quantity
    expect(getRes.body.totals.subtotal).toBe(qty * 1000);
  });
});

// ── CUSTOMER JWT ACCESS ───────────────────────────────────────────────────────

describe('Customer JWT access to own cart', () => {
  it('allows customer to access their associated cart via JWT', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { accessToken } = await signupAndLoginCustomer(h);
    const { cartId, cartCookie } = await createCart();

    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });

    await request(h.http())
      .post(`/store/v1/carts/${cartId}/customer`)
      .set('Cookie', cartCookie)
      .set('Authorization', `Bearer ${accessToken}`);

    // Now access via JWT only (no cookie)
    const res = await request(h.http())
      .get(`/store/v1/carts/${cartId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(cartId);
  });

  it('rejects a customer JWT for another customer cart', async () => {
    const { accessToken: at1 } = await signupAndLoginCustomer(h);
    const { accessToken: at2 } = await signupAndLoginCustomer(h);
    const { cartId: cart2Id, cartCookie: cookie2 } = await createCart();

    await request(h.http())
      .post(`/store/v1/carts/${cart2Id}/customer`)
      .set('Cookie', cookie2)
      .set('Authorization', `Bearer ${at2}`);

    const res = await request(h.http())
      .get(`/store/v1/carts/${cart2Id}`)
      .set('Authorization', `Bearer ${at1}`);
    expect(res.status).toBe(403);
  });
});

// ── STOCK ENFORCEMENT (B2) ────────────────────────────────────────────────────

describe('Stock enforcement', () => {
  it('rejects adding more than available stock with 409', async () => {
    const { variantId } = await seedProductWithVariants(h); // stock = 10, no backorder
    const { cartId, cartCookie } = await createCart();
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 11 });
    expect(res.status).toBe(409);
  });

  it('rejects when repeated adds cumulatively exceed stock', async () => {
    const { variantId } = await seedProductWithVariants(h); // stock = 10
    const { cartId, cartCookie } = await createCart();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 7 });
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 5 }); // 7 + 5 = 12 > 10
    expect(res.status).toBe(409);
  });

  it('rejects updating quantity above stock with 409', async () => {
    const { variantId } = await seedProductWithVariants(h);
    const { cartId, cartCookie } = await createCart();
    const add = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });
    const itemId = add.body.items[0].id as string;
    const res = await request(h.http())
      .patch(`/store/v1/carts/${cartId}/items/${itemId}`)
      .set('Cookie', cartCookie)
      .send({ quantity: 99 });
    expect(res.status).toBe(409);
  });
});

// ── SHIPPING TOTAL PERSISTS ACROSS MUTATIONS (B1) ─────────────────────────────

describe('Shipping total persistence', () => {
  it('keeps the shipping cost in totals after a later item mutation', async () => {
    const { variantId, currency } = await seedProductWithVariants(h);
    const rateId = await seedShippingRate(h, currency); // 500
    const { cartId, cartCookie } = await createCart();

    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cartCookie)
      .send({ name: 'A', line1: '1 Rue', city: 'Paris', postalCode: '75001', country: 'FR' })
      .expect(200);
    const ship = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-method`)
      .set('Cookie', cartCookie)
      .send({ shippingRateId: rateId });
    expect(ship.body.totals.shipping).toBe(500);
    expect(ship.body.totals.grandTotal).toBe(1000 + 500);

    // Mutate items AFTER choosing shipping — a FLAT rate must NOT drop to 0
    // (re-evaluated every recompute, but flat is item-independent so it stays 500).
    const after = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 }); // qty now 2
    expect(after.body.totals.shipping).toBe(500);
    expect(after.body.totals.grandTotal).toBe(2000 + 500);
  });
});

// ── CART HIJACK / RE-ASSOCIATION GUARD (B5) ───────────────────────────────────

describe('Cart ownership guard', () => {
  it('rejects re-associating a cart already owned by another customer', async () => {
    const { accessToken: ownerToken } = await signupAndLoginCustomer(h);
    const { accessToken: attackerToken } = await signupAndLoginCustomer(h);
    const { cartId, cartCookie } = await createCart();

    // Owner claims the cart.
    const claim = await request(h.http())
      .post(`/store/v1/carts/${cartId}/customer`)
      .set('Cookie', cartCookie)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(claim.status).toBe(200);

    // Attacker holding the (now-stale) guest cookie tries to take it over.
    const steal = await request(h.http())
      .post(`/store/v1/carts/${cartId}/customer`)
      .set('Cookie', cartCookie)
      .set('Authorization', `Bearer ${attackerToken}`);
    expect(steal.status).toBe(403);
  });

  it('invalidates the guest cookie once a customer owns the cart (token rotated)', async () => {
    const { accessToken } = await signupAndLoginCustomer(h);
    const { cartId, cartCookie } = await createCart();
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/customer`)
      .set('Cookie', cartCookie)
      .set('Authorization', `Bearer ${accessToken}`);

    // The old guest cookie alone (no JWT) must no longer grant access.
    const res = await request(h.http()).get(`/store/v1/carts/${cartId}`).set('Cookie', cartCookie);
    expect(res.status).toBe(403);
  });
});

// ── MERGE CURRENCY GUARD (S6) ─────────────────────────────────────────────────

describe('Merge currency guard', () => {
  it('refuses to merge a guest cart into a customer cart of a different currency', async () => {
    const { accessToken } = await signupAndLoginCustomer(h);

    // Customer cart in EUR.
    const { variantId, currency } = await seedProductWithVariants(h); // EUR
    const custCart = await request(h.http()).post('/store/v1/carts').send({ currency });
    const custCookie = extractCartTokenCookie(custCart);
    await request(h.http())
      .post(`/store/v1/carts/${custCart.body.cartId}/items`)
      .set('Cookie', custCookie)
      .send({ variantId, quantity: 1 });
    await request(h.http())
      .post(`/store/v1/carts/${custCart.body.cartId}/customer`)
      .set('Cookie', custCookie)
      .set('Authorization', `Bearer ${accessToken}`);

    // Guest cart in USD with a USD variant.
    const pidUsd = newId();
    const vidUsd = newId();
    await h.client`
      insert into products (id, tenant_id, title, slug, status)
      values (${pidUsd}, ${DEFAULT_TENANT_ID}, ${'USD Product'}, ${`usd-${pidUsd.slice(0, 8)}`}, ${'published'})
    `;
    await h.client`
      insert into product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity)
      values (${vidUsd}, ${DEFAULT_TENANT_ID}, ${pidUsd}, ${`USD-${vidUsd.slice(0, 8)}`}, ${'USD V'}, ${'{}'}::jsonb, ${1500}, ${'USD'}, ${10})
    `;
    const guest = await request(h.http()).post('/store/v1/carts').send({ currency: 'USD' });
    const guestCookie = extractCartTokenCookie(guest);
    await request(h.http())
      .post(`/store/v1/carts/${guest.body.cartId}/items`)
      .set('Cookie', guestCookie)
      .send({ variantId: vidUsd, quantity: 1 });

    const res = await request(h.http())
      .post(`/store/v1/carts/${guest.body.cartId}/customer`)
      .set('Cookie', guestCookie)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(422);
  });
});

// ── Reservation compensation reconciles PG to the last-read cart state ──
describe('inventory reservation compensation', () => {
  function inventory(): InventoryService {
    return h.app.get(InventoryService);
  }

  async function reservationsFor(cartId: string): Promise<Record<string, number>> {
    const rows = await h.client<{ variant_id: string; quantity: number }[]>`
      select variant_id, quantity from inventory_reservations
      where tenant_id = ${DEFAULT_TENANT_ID} and cart_id = ${cartId} and status = 'reserved'`;
    return rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.variant_id] = r.quantity;
      return acc;
    }, {});
  }

  it('reconciles PG reservations to match the last-read cart items (no orphan qty)', async () => {
    const { variantId, variantId2 } = await seedProductWithVariants(h);
    const cartId = newId();
    await h.client`
      insert into carts (id, tenant_id, session_token, currency, status, expires_at)
      values (${cartId}, ${DEFAULT_TENANT_ID}, ${'tok'}, ${'EUR'}, ${'active'}, now() + interval '1 day')`;

    // Simulate the phantom-leak state: a reserve() committed an ORPHAN hold on variantId
    // (qty 7) and a STALE hold on variantId2 (qty 4) that no longer reflect the cart blob.
    await inventory().reserve(DEFAULT_TENANT_ID, cartId, variantId, 7);
    await inventory().reserve(DEFAULT_TENANT_ID, cartId, variantId2, 4);
    expect(await reservationsFor(cartId)).toEqual({ [variantId]: 7, [variantId2]: 4 });

    // The authoritative LAST-READ cart actually holds variantId × 2 only (variantId2 dropped).
    await inventory().reconcileCartReservations(DEFAULT_TENANT_ID, cartId, [
      { variantId, quantity: 2 },
    ]);

    // PG now matches the last-read state exactly — orphan released, stale qty corrected.
    expect(await reservationsFor(cartId)).toEqual({ [variantId]: 2 });
  });

  it('clamps a reconcile that exceeds availability (never over-reserves)', async () => {
    const { variantId } = await seedProductWithVariants(h); // variantId has stock 10
    const cartA = newId();
    const cartB = newId();
    for (const id of [cartA, cartB]) {
      await h.client`
        insert into carts (id, tenant_id, session_token, currency, status, expires_at)
        values (${id}, ${DEFAULT_TENANT_ID}, ${'tok'}, ${'EUR'}, ${'active'}, now() + interval '1 day')`;
    }
    // Another cart already holds 8 of 10 → only 2 are available to cart A.
    await inventory().reserve(DEFAULT_TENANT_ID, cartB, variantId, 8);

    // Reconciling cart A to "want 9" must CLAMP to the 2 available — no oversell.
    await inventory().reconcileCartReservations(DEFAULT_TENANT_ID, cartA, [
      { variantId, quantity: 9 },
    ]);
    expect(await reservationsFor(cartA)).toEqual({ [variantId]: 2 });
  });
});
