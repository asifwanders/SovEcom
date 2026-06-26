/**
 * Tax engine integration tests.
 *
 * Full AppModule against real Postgres + Redis (reuses the cart harness). Covers:
 *  - Admin tax-settings GET/PUT, permission-gated (401/403)
 *  - The EU guardrail (EU origin + tax_mode none → 422; non-EU origin + none → ok)
 *  - tax_mode='none' cart → taxTotal 0 (default fresh store)
 *  - tax_mode='eu_vat' cart WITH a shipping address → correct VAT in totals (exclusive)
 *  - tax_mode='eu_vat' cart WITHOUT an address → taxTotal 0 (destination undeterminable)
 *  - tax-inclusive extraction
 *  - switching tax_mode recomputes cart totals
 *  - B2B reverse charge through the cart + recompute on the claim path
 *  - admin tax_rates CRUD
 *  - tenant isolation: the cart-owner b2b/vat lookup is tenant-scoped (a B2B customer in
 *    another tenant grants no reverse charge)
 */
import request from 'supertest';
import {
  bootCartApp,
  resetCartState,
  seedProductWithVariants,
  seedAdminAndLogin,
  seedTaxRate,
  setTaxSettings,
  seedCustomerRow,
  signupAndLoginCustomer,
  extractCartTokenCookie,
  newId,
  uniqEmail,
  DEFAULT_TENANT_ID,
  CartHarness,
} from '../cart/_cart-harness';
import { TaxesService } from '../../../src/taxes/taxes.service';
import type { CartState } from '../../../src/cart/cart.types';

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

const SETTINGS = '/admin/v1/taxes/settings';
const RATES = '/admin/v1/taxes/rates';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Create a cart holding `qty` of the €10.00 variant A; returns ids + cookie. */
async function cartWithItems(qty = 1): Promise<{ cartId: string; cookie: string }> {
  const { variantId } = await seedProductWithVariants(h); // variant A = 1000 (€10.00)
  const res = await request(h.http()).post('/store/v1/carts').send({});
  const cartId = res.body.cartId as string;
  const cookie = extractCartTokenCookie(res);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cookie)
    .send({ variantId, quantity: qty })
    .expect(201);
  return { cartId, cookie };
}

const FR_ADDRESS = {
  name: 'Jean Test',
  line1: '1 rue de Test',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};

// ── Admin tax-settings: permission gating ─────────────────────────────────────

describe('Admin /admin/v1/taxes/settings', () => {
  it('rejects unauthenticated requests with 401', async () => {
    await request(h.http()).get(SETTINGS).expect(401);
    await request(h.http()).put(SETTINGS).send({ taxMode: 'eu_vat' }).expect(401);
  });

  it('rejects a staff role (no settings:write) with 403', async () => {
    const staff = await seedAdminAndLogin(h, 'staff');
    await request(h.http())
      .put(SETTINGS)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .send({ taxMode: 'eu_vat' })
      .expect(403);
  });

  it('GET returns the fresh-store defaults (none / inclusive)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const res = await request(h.http())
      .get(SETTINGS)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(res.body.taxMode).toBe('none');
    expect(res.body.pricesIncludeTax).toBe(true);
    expect(res.body.ossPosture).toBe('below_threshold');
  });

  it('PUT updates the regime + registration and reflects on GET', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const auth = { Authorization: `Bearer ${admin.accessToken}` };
    const put = await request(h.http())
      .put(SETTINGS)
      .set(auth)
      .send({
        taxMode: 'eu_vat',
        pricesIncludeTax: false,
        ossPosture: 'above_or_opted_in',
        euVatRegistration: { originCountry: 'fr', vatNumber: 'FR123' },
      })
      .expect(200);
    expect(put.body.taxMode).toBe('eu_vat');
    expect(put.body.euVatRegistration.originCountry).toBe('FR'); // upper-cased

    const get = await request(h.http()).get(SETTINGS).set(auth).expect(200);
    expect(get.body.pricesIncludeTax).toBe(false);
    expect(get.body.ossPosture).toBe('above_or_opted_in');
  });
});

// ── EU guardrail (settings-write layer) ──────────────────────────

describe('EU guardrail', () => {
  it('rejects tax_mode=none when the origin is an EU-27 country (422)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const auth = { Authorization: `Bearer ${admin.accessToken}` };
    // Establish an EU origin first.
    await request(h.http())
      .put(SETTINGS)
      .set(auth)
      .send({ taxMode: 'eu_vat', euVatRegistration: { originCountry: 'FR' } })
      .expect(200);
    // Now try to disable VAT → blocked.
    await request(h.http()).put(SETTINGS).set(auth).send({ taxMode: 'none' }).expect(422);
  });

  it('allows tax_mode=none for a non-EU origin', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const auth = { Authorization: `Bearer ${admin.accessToken}` };
    const res = await request(h.http())
      .put(SETTINGS)
      .set(auth)
      .send({ taxMode: 'none', euVatRegistration: { originCountry: 'PK' } })
      .expect(200);
    expect(res.body.taxMode).toBe('none');
  });

  it('rejects setting an EU origin while staying tax_mode=none in one request (422)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const auth = { Authorization: `Bearer ${admin.accessToken}` };
    // Fresh store is none; setting an EU origin without switching to eu_vat is the foot-gun.
    await request(h.http())
      .put(SETTINGS)
      .set(auth)
      .send({ euVatRegistration: { originCountry: 'DE' } })
      .expect(422);
  });
});

// ── Cart totals: none mode ────────────────────────────────────────────────────

describe('cart totals — tax_mode none', () => {
  it('default fresh store → taxTotal 0 even with a shipping address', async () => {
    const { cartId, cookie } = await cartWithItems(2); // subtotal 2000
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cookie)
      .send(FR_ADDRESS)
      .expect(200);
    expect(res.body.totals.taxTotal).toBe(0);
    expect(res.body.totals.subtotal).toBe(2000);
    expect(res.body.totals.grandTotal).toBe(2000);
  });
});

// ── Cart totals: eu_vat mode ──────────────────────────────────────────────────

describe('cart totals — tax_mode eu_vat', () => {
  it('WITH a FR shipping address → 20% VAT added (exclusive)', async () => {
    await seedTaxRate(h, 'FR', '0.2000', 'TVA standard');
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      pricesIncludeTax: false,
      originCountry: 'FR',
      ossPosture: 'below_threshold',
    });

    const { cartId, cookie } = await cartWithItems(2); // subtotal 2000
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cookie)
      .send(FR_ADDRESS)
      .expect(200);
    expect(res.body.totals.taxTotal).toBe(400); // 2000 × 0.20
    expect(res.body.totals.grandTotal).toBe(2400); // exclusive → added on top
  });

  it('WITHOUT a shipping address → taxTotal 0 (destination undeterminable)', async () => {
    await seedTaxRate(h, 'FR', '0.2000');
    await setTaxSettings(h, { taxMode: 'eu_vat', pricesIncludeTax: false, originCountry: 'FR' });

    const { cartId, cookie } = await cartWithItems(2);
    const res = await request(h.http())
      .get(`/store/v1/carts/${cartId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.totals.taxTotal).toBe(0);
  });

  it('tax-INCLUSIVE → VAT extracted, grandTotal unchanged (already in price)', async () => {
    await seedTaxRate(h, 'FR', '0.2000');
    await setTaxSettings(h, { taxMode: 'eu_vat', pricesIncludeTax: true, originCountry: 'FR' });

    const { cartId, cookie } = await cartWithItems(2); // gross subtotal 2000
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cookie)
      .send(FR_ADDRESS)
      .expect(200);
    // 2000 gross incl 20% → net round(2000/1.2)=round(1666.67)=1667 → tax 333.
    expect(res.body.totals.taxTotal).toBe(333);
    expect(res.body.totals.grandTotal).toBe(2000); // inclusive → not added again
  });

  it('cross-border FR→DE below threshold charges ORIGIN (FR 20%) VAT', async () => {
    await seedTaxRate(h, 'FR', '0.2000');
    await seedTaxRate(h, 'DE', '0.1900');
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      pricesIncludeTax: false,
      originCountry: 'FR',
      ossPosture: 'below_threshold',
    });

    const { cartId, cookie } = await cartWithItems(2); // subtotal 2000
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cookie)
      .send({ ...FR_ADDRESS, country: 'DE', city: 'Berlin', postalCode: '10115' })
      .expect(200);
    expect(res.body.totals.taxTotal).toBe(400); // origin FR 20%, not DE 19% (380)
  });

  it('cross-border FR→DE above threshold charges DESTINATION (DE 19%) VAT', async () => {
    await seedTaxRate(h, 'FR', '0.2000');
    await seedTaxRate(h, 'DE', '0.1900');
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      pricesIncludeTax: false,
      originCountry: 'FR',
      ossPosture: 'above_or_opted_in',
    });

    const { cartId, cookie } = await cartWithItems(2); // subtotal 2000
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cookie)
      .send({ ...FR_ADDRESS, country: 'DE', city: 'Berlin', postalCode: '10115' })
      .expect(200);
    expect(res.body.totals.taxTotal).toBe(380); // destination DE 19%
  });
});

// ── Mode switch recompute ─────────────────────────────────────────────────────

describe('switching tax_mode recomputes cart totals', () => {
  it('none → eu_vat flips taxTotal on the next recompute', async () => {
    await seedTaxRate(h, 'FR', '0.2000');
    const { cartId, cookie } = await cartWithItems(2); // subtotal 2000

    // Start in none (default): set address → tax 0.
    let res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cookie)
      .send(FR_ADDRESS)
      .expect(200);
    expect(res.body.totals.taxTotal).toBe(0);

    // Switch to eu_vat, then trigger a recompute (re-set the address).
    await setTaxSettings(h, { taxMode: 'eu_vat', pricesIncludeTax: false, originCountry: 'FR' });
    res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cookie)
      .send(FR_ADDRESS)
      .expect(200);
    expect(res.body.totals.taxTotal).toBe(400);
  });
});

// ── B2B reverse charge through the cart + claim-path recompute ──

describe('B2B reverse charge through the cart', () => {
  it('B2B VIES-validated customer claiming a guest cart → reverse charge recomputes AT claim', async () => {
    await seedTaxRate(h, 'FR', '0.2000');
    await seedTaxRate(h, 'DE', '0.1900');
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      pricesIncludeTax: false,
      originCountry: 'FR',
      ossPosture: 'below_threshold',
    });

    // Guest cart, cross-border FR→DE below threshold → B2C → origin FR 20% → 400.
    const { variantId } = await seedProductWithVariants(h);
    const create = await request(h.http()).post('/store/v1/carts').send({});
    const cartId = create.body.cartId as string;
    const cookie = extractCartTokenCookie(create);
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cookie)
      .send({ variantId, quantity: 2 }) // subtotal 2000
      .expect(201);
    const guest = await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cookie)
      .send({ ...FR_ADDRESS, country: 'DE', city: 'Berlin', postalCode: '10115' })
      .expect(200);
    expect(guest.body.totals.taxTotal).toBe(400); // B2C origin FR 20%

    // A B2B + VIES-validated customer claims the cart.
    const { accessToken, customerId } = await signupAndLoginCustomer(h);
    await h.client`update customers set is_b2b = true, vat_validated = true where id = ${customerId}`;
    const claim = await request(h.http())
      .post(`/store/v1/carts/${cartId}/customer`)
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // S1: the claim path recomputes from the new owner's context → cross-border B2B
    // reverse charge → 0% VAT, WITHOUT needing a further cart mutation.
    expect(claim.body.totals.taxTotal).toBe(0);
  });
});

// ── Tenant isolation of the cart-owner b2b/vat lookup ─────────────────────────

describe('tenant isolation — reverse-charge owner lookup is tenant-scoped', () => {
  it('a B2B customer in ANOTHER tenant grants no reverse charge; same attrs in this tenant does', async () => {
    await seedTaxRate(h, 'FR', '0.2000');
    await seedTaxRate(h, 'DE', '0.1900');
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      pricesIncludeTax: false,
      originCountry: 'FR',
      ossPosture: 'below_threshold',
    });
    const taxes = h.app.get(TaxesService, { strict: false });

    // A B2B + VIES-validated customer that exists ONLY in a second tenant.
    const otherTenantId = '01900000-0000-7000-8000-0000000000ff';
    await h.client`
      insert into tenants (id, name, slug, settings)
      values (${otherTenantId}, ${'Other Tenant'}, ${'other-tenant'}, ${'{}'}::jsonb)
      on conflict (id) do nothing
    `;
    const foreignCustomerId = newId();
    await h.client`
      insert into customers (id, tenant_id, email, is_b2b, vat_validated)
      values (${foreignCustomerId}, ${otherTenantId}, ${uniqEmail()}, true, true)
    `;

    const baseCart = {
      currency: 'EUR',
      items: [{ unitPriceAmount: 1000, quantity: 2 }], // subtotal 2000
      shippingAmount: 0,
      totals: { discountTotal: 0 },
      shippingAddress: { country: 'DE' }, // cross-border from FR origin
      customerId: foreignCustomerId,
    } as unknown as CartState;

    // The owner lookup is scoped to the DEFAULT tenant → the foreign B2B customer is
    // invisible → treated as B2C → cross-border below threshold charges ORIGIN FR 20%,
    // NOT reverse charge.
    const foreign = await taxes.resolveForCart(DEFAULT_TENANT_ID, baseCart);
    expect(foreign.taxTotal).toBe(400);

    // Positive control: the SAME attributes seeded in the DEFAULT tenant → visible →
    // reverse charge applies → 0% VAT.
    const localB2b = await seedCustomerRow(h, { isB2b: true, vatValidated: true });
    const localCart = { ...baseCart, customerId: localB2b } as unknown as CartState;
    const local = await taxes.resolveForCart(DEFAULT_TENANT_ID, localCart);
    expect(local.taxTotal).toBe(0);
  });
});

// ── Tax rates CRUD ────────────────────────────────────────────────────────────

describe('Admin /admin/v1/taxes/rates', () => {
  it('creates, lists, updates and deletes a rate (permission-gated)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const auth = { Authorization: `Bearer ${admin.accessToken}` };

    const created = await request(h.http())
      .post(RATES)
      .set(auth)
      .send({ country: 'it', rate: '0.2200', name: 'IVA' })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.country).toBe('IT'); // upper-cased

    const list = await request(h.http()).get(RATES).set(auth).expect(200);
    expect(list.body.some((r: { id: string }) => r.id === id)).toBe(true);

    await request(h.http()).put(`${RATES}/${id}`).set(auth).send({ rate: '0.2100' }).expect(200);
    await request(h.http()).delete(`${RATES}/${id}`).set(auth).expect(204);
    await request(h.http()).put(`${RATES}/${id}`).set(auth).send({ rate: '0.2000' }).expect(404);
  });

  it('rejects an out-of-range rate (≥ 1) with 400', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await request(h.http())
      .post(RATES)
      .set({ Authorization: `Bearer ${admin.accessToken}` })
      .send({ country: 'FR', rate: '1.5000', name: 'bad' })
      .expect(400);
  });
});
