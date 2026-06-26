/**
 * Shipping engine integration tests.
 *
 * Full AppModule against real Postgres + Redis (reuses the cart harness). Covers:
 *  - Admin zone/rate CRUD, permission-gated (403 staff) + zone/free_over validation
 *  - Store GET /carts/:id/shipping-rates: zone match, currency filter, weight bands
 *  - Cart method selection: availability gate (422), totals recompute
 *  - free_over uses the POST-discount base; cost re-evaluates every recompute (flip)
 *  - address moved out of zone clears the selection
 *  - tenant isolation (another tenant's rate never offered)
 */
import request from 'supertest';
import {
  bootCartApp,
  resetCartState,
  seedProductWithVariants,
  seedAdminAndLogin,
  seedDiscount,
  extractCartTokenCookie,
  newId,
  DEFAULT_TENANT_ID,
  CartHarness,
} from '../cart/_cart-harness';

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

const ZONES = '/admin/v1/shipping/zones';
const RATES = '/admin/v1/shipping/rates';
const FR = { name: 'A', line1: '1 Rue', city: 'Paris', postalCode: '75001', country: 'FR' };

// ── local seeders (direct SQL, full control over rate shape) ───────────────────

async function seedZone(countries: string[], tenantId = DEFAULT_TENANT_ID): Promise<string> {
  const id = newId();
  await h.client`
    insert into shipping_zones (id, tenant_id, name, countries)
    values (${id}, ${tenantId}, ${'Zone ' + countries.join(',')}, ${JSON.stringify(countries)}::jsonb)
  `;
  return id;
}

async function seedRate(
  zoneId: string,
  r: {
    type: 'flat' | 'free_over' | 'weight_based';
    amount: number;
    currency?: string;
    freeOver?: number | null;
    min?: number | null;
    max?: number | null;
  },
  tenantId = DEFAULT_TENANT_ID,
): Promise<string> {
  const id = newId();
  await h.client`
    insert into shipping_rates
      (id, tenant_id, zone_id, name, type, amount, currency, free_over_amount, weight_min_grams, weight_max_grams)
    values (${id}, ${tenantId}, ${zoneId}, ${'R-' + r.type}, ${r.type}, ${r.amount},
      ${r.currency ?? 'EUR'}, ${r.freeOver ?? null}, ${r.min ?? null}, ${r.max ?? null})
  `;
  return id;
}

async function cartWithItems(
  qty = 1,
): Promise<{ cartId: string; cookie: string; variantId: string }> {
  const { variantId } = await seedProductWithVariants(h); // variant A = 1000
  const res = await request(h.http()).post('/store/v1/carts').send({});
  const cartId = res.body.cartId as string;
  const cookie = extractCartTokenCookie(res);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cookie)
    .send({ variantId, quantity: qty })
    .expect(201);
  return { cartId, cookie, variantId };
}

async function setAddress(
  cartId: string,
  cookie: string,
  country = 'FR',
): Promise<request.Response> {
  return request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-address`)
    .set('Cookie', cookie)
    .send({ ...FR, country })
    .expect(200);
}

// ── Admin CRUD ─────────────────────────────────────────────────────────────────

describe('Admin /admin/v1/shipping', () => {
  it('rejects a staff role (no settings:write) with 403', async () => {
    const staff = await seedAdminAndLogin(h, 'staff');
    await request(h.http())
      .post(ZONES)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .send({ name: 'EU', countries: ['FR'] })
      .expect(403);
  });

  it('CRUDs a zone and a rate (permission-gated)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const auth = { Authorization: `Bearer ${admin.accessToken}` };

    const zone = await request(h.http())
      .post(ZONES)
      .set(auth)
      .send({ name: 'EU', countries: ['fr', 'de'] })
      .expect(201);
    expect(zone.body.countries).toEqual(['FR', 'DE']); // upper-cased

    const rate = await request(h.http())
      .post(RATES)
      .set(auth)
      .send({ zoneId: zone.body.id, name: 'Std', type: 'flat', amount: 490, currency: 'eur' })
      .expect(201);
    expect(rate.body.currency).toBe('EUR');

    const list = await request(h.http()).get(RATES).set(auth).expect(200);
    expect(list.body.some((r: { id: string }) => r.id === rate.body.id)).toBe(true);

    await request(h.http())
      .put(`${RATES}/${rate.body.id}`)
      .set(auth)
      .send({ amount: 590 })
      .expect(200);
    await request(h.http()).delete(`${RATES}/${rate.body.id}`).set(auth).expect(204);
    await request(h.http())
      .put(`${RATES}/${rate.body.id}`)
      .set(auth)
      .send({ amount: 600 })
      .expect(404);
  });

  it('rejects a rate whose zone is not in the tenant (422)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(RATES)
      .set({ Authorization: `Bearer ${admin.accessToken}` })
      .send({ zoneId: newId(), name: 'X', type: 'flat', amount: 100, currency: 'EUR' })
      .expect(422);
  });

  it('rejects a free_over rate with no threshold (400)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const zone = await request(h.http())
      .post(ZONES)
      .set({ Authorization: `Bearer ${admin.accessToken}` })
      .send({ name: 'EU', countries: ['FR'] })
      .expect(201);
    await request(h.http())
      .post(RATES)
      .set({ Authorization: `Bearer ${admin.accessToken}` })
      .send({ zoneId: zone.body.id, name: 'Free', type: 'free_over', amount: 500, currency: 'EUR' })
      .expect(400);
  });

  // ── PATCH-merge validation ────────────────

  it('rejects a PATCH that pushes weight_min above the STORED weight_max (422)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const auth = { Authorization: `Bearer ${admin.accessToken}` };
    const zone = await request(h.http())
      .post(ZONES)
      .set(auth)
      .send({ name: 'EU', countries: ['FR'] })
      .expect(201);

    // A valid weight band 0..1000g.
    const rate = await request(h.http())
      .post(RATES)
      .set(auth)
      .send({
        zoneId: zone.body.id,
        name: 'Band',
        type: 'weight_based',
        amount: 400,
        currency: 'EUR',
        weightMinGrams: 0,
        weightMaxGrams: 1000,
      })
      .expect(201);

    // PATCH only weight_min to 2000 — the body alone is fine, but MERGED against the
    // stored max (1000) it violates min ≤ max. Must be rejected (currently slips through).
    await request(h.http())
      .put(`${RATES}/${rate.body.id}`)
      .set(auth)
      .send({ weightMinGrams: 2000 })
      .expect(422);
  });

  it('rejects a PATCH that clears freeOverAmount on a free_over rate (422)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const auth = { Authorization: `Bearer ${admin.accessToken}` };
    const zone = await request(h.http())
      .post(ZONES)
      .set(auth)
      .send({ name: 'EU', countries: ['FR'] })
      .expect(201);

    const rate = await request(h.http())
      .post(RATES)
      .set(auth)
      .send({
        zoneId: zone.body.id,
        name: 'FreeOver',
        type: 'free_over',
        amount: 500,
        currency: 'EUR',
        freeOverAmount: 5000,
      })
      .expect(201);

    // Explicitly null the threshold — the merged free_over row would have no threshold.
    await request(h.http())
      .put(`${RATES}/${rate.body.id}`)
      .set(auth)
      .send({ freeOverAmount: null })
      .expect(422);
  });
});

// ── Store rates endpoint ───────────────────────────────────────────────────────

describe('GET /store/v1/carts/:id/shipping-rates', () => {
  it('returns [] when the cart has no shipping address', async () => {
    const zone = await seedZone(['FR']);
    await seedRate(zone, { type: 'flat', amount: 500 });
    const { cartId, cookie } = await cartWithItems(1);
    const res = await request(h.http())
      .get(`/store/v1/carts/${cartId}/shipping-rates`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it('returns the matching-zone rate with its computed cost, sorted by cost', async () => {
    const zone = await seedZone(['FR', 'DE']);
    await seedRate(zone, { type: 'flat', amount: 900 });
    await seedRate(zone, { type: 'flat', amount: 500 });
    const { cartId, cookie } = await cartWithItems(1);
    await setAddress(cartId, cookie, 'FR');
    const res = await request(h.http())
      .get(`/store/v1/carts/${cartId}/shipping-rates`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.map((r: { amount: number }) => r.amount)).toEqual([500, 900]); // cost asc
  });

  it('excludes a rate in another currency', async () => {
    const zone = await seedZone(['FR']);
    await seedRate(zone, { type: 'flat', amount: 500, currency: 'USD' });
    const { cartId, cookie } = await cartWithItems(1); // EUR cart
    await setAddress(cartId, cookie, 'FR');
    const res = await request(h.http())
      .get(`/store/v1/carts/${cartId}/shipping-rates`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it('weight bands: only the band matching the cart weight is offered', async () => {
    const zone = await seedZone(['FR']);
    await seedRate(zone, { type: 'weight_based', amount: 400, min: 0, max: 1000 });
    await seedRate(zone, { type: 'weight_based', amount: 900, min: 1001, max: null });
    const { cartId, cookie, variantId } = await cartWithItems(2); // 2 units
    await h.client`update product_variants set weight_grams = 300 where id = ${variantId}`;
    await setAddress(cartId, cookie, 'FR'); // recompute reads weights → 600g

    let res = await request(h.http())
      .get(`/store/v1/carts/${cartId}/shipping-rates`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.map((r: { amount: number }) => r.amount)).toEqual([400]); // 600g → band A only

    // Bump to 4 units = 1200g → band B only.
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cookie)
      .send({ variantId, quantity: 2 })
      .expect(201);
    res = await request(h.http())
      .get(`/store/v1/carts/${cartId}/shipping-rates`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.map((r: { amount: number }) => r.amount)).toEqual([900]);
  });
});

// ── Method selection + recompute ───────────────────────────────────────────────

describe('cart shipping method + recompute', () => {
  it('selecting a rate sets the computed shipping in totals', async () => {
    const zone = await seedZone(['FR']);
    const rateId = await seedRate(zone, { type: 'flat', amount: 500 });
    const { cartId, cookie } = await cartWithItems(1); // subtotal 1000
    await setAddress(cartId, cookie, 'FR');
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-method`)
      .set('Cookie', cookie)
      .send({ shippingRateId: rateId })
      .expect(200);
    expect(res.body.totals.shipping).toBe(500);
    expect(res.body.totals.grandTotal).toBe(1500);
  });

  it('free_over uses the POST-discount base, and the cost re-evaluates on every recompute', async () => {
    const zone = await seedZone(['FR']);
    // Free over 1600; charge 590 otherwise.
    const rateId = await seedRate(zone, { type: 'free_over', amount: 590, freeOver: 1600 });
    await seedDiscount(h, { type: 'percentage', value: 3000 }); // automatic 30% off

    const { cartId, cookie, variantId } = await cartWithItems(2); // subtotal 2000, −30% → 1400
    await setAddress(cartId, cookie, 'FR');

    // Post-discount base 1400 < 1600 → CHARGED (pre-discount 2000 would have been free → proves base).
    let res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-method`)
      .set('Cookie', cookie)
      .send({ shippingRateId: rateId })
      .expect(200);
    expect(res.body.totals.shipping).toBe(590);

    // Add 2 more units → subtotal 4000, −30% → 2800 ≥ 1600 → now FREE, WITHOUT re-selecting.
    res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cookie)
      .send({ variantId, quantity: 2 })
      .expect(201);
    expect(res.body.totals.shipping).toBe(0); // re-evaluated on recompute
  });

  it('moving the address out of every zone clears the selected shipping', async () => {
    const zone = await seedZone(['FR']); // FR only
    const rateId = await seedRate(zone, { type: 'flat', amount: 500 });
    const { cartId, cookie } = await cartWithItems(1);
    await setAddress(cartId, cookie, 'FR');
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-method`)
      .set('Cookie', cookie)
      .send({ shippingRateId: rateId })
      .expect(200);

    // Move to a country no zone covers → recompute clears the selection.
    const res = await setAddress(cartId, cookie, 'US');
    expect(res.body.totals.shipping).toBe(0);
    expect(res.body.shippingRateId).toBeNull();
  });
});

// ── Tenant isolation ───────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it("never offers another tenant's shipping rate", async () => {
    // A FR zone + rate under a SECOND tenant.
    const otherTenantId = '01900000-0000-7000-8000-0000000000ee';
    await h.client`
      insert into tenants (id, name, slug) values (${otherTenantId}, ${'Other'}, ${'other-ship'})
      on conflict (id) do nothing
    `;
    const otherZone = await seedZone(['FR'], otherTenantId);
    await seedRate(otherZone, { type: 'flat', amount: 500 }, otherTenantId);

    const { cartId, cookie } = await cartWithItems(1); // DEFAULT tenant cart
    await setAddress(cartId, cookie, 'FR');
    const res = await request(h.http())
      .get(`/store/v1/carts/${cartId}/shipping-rates`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body).toEqual([]); // the other tenant's FR rate is invisible
  });
});
