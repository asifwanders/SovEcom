/**
 * OSS CSV export integration tests.
 *
 * Full AppModule against real Postgres + Redis. The OSS export reports the cross-border
 * B2C consideration charged DESTINATION VAT for an `eu_vat` tenant that is OVER the €10k
 * threshold / opted in (`oss_posture='above_or_opted_in'`): destination ≠ origin, both EU,
 * B2C, not cancelled, within [from,to]. Covers:
 *  - eu_vat FR-origin, above-threshold tenant: a sale shipped to DE (cross-border) IS
 *    exported — a GOODS row PLUS a SHIPPING row (ancillary cost follows the goods); a sale
 *    shipped to FR (domestic) is NOT;
 *  - Σ exported VAT for an order == order.tax_amount (goods VAT + shipping VAT);
 *  - free / untaxed shipping → no shipping row;
 *  - a below-threshold eu_vat tenant → header-only (origin-rated, declared domestically, NOT OSS);
 *  - a cancelled / domestic / B2B cross-border sale is excluded;
 *  - tenant isolation: a second tenant's cross-border sale never leaks;
 *  - a none-mode tenant → header-only (empty) CSV.
 */
import request from 'supertest';
import {
  bootCartApp,
  resetOrderState,
  seedSimpleProduct,
  seedAdminAndLogin,
  setTaxSettings,
  extractCartTokenCookie,
  DEFAULT_TENANT_ID,
  newId,
  type CartHarness,
} from './_orders-harness';

let h: CartHarness;

beforeAll(async () => {
  h = await bootCartApp();
}, 30_000);

afterAll(async () => {
  await h.app.close();
  await h.client.end();
});

beforeEach(async () => {
  await resetOrderState(h);
}, 10_000);

/** Seed a zone covering FR+DE and a flat EUR rate; returns nothing (rate auto-found). */
async function seedFrDeShipping(amount = 500): Promise<void> {
  const zoneId = newId();
  await h.client`
    insert into shipping_zones (id, tenant_id, name, countries)
    values (${zoneId}, ${DEFAULT_TENANT_ID}, ${'EU'}, ${JSON.stringify(['FR', 'DE'])}::jsonb)
  `;
  await h.client`
    insert into shipping_rates (id, tenant_id, zone_id, name, type, amount, currency)
    values (${newId()}, ${DEFAULT_TENANT_ID}, ${zoneId}, ${'Std'}, ${'flat'}, ${amount}, ${'EUR'})
  `;
}

/** Seed a tax rate for a country (fraction string e.g. '0.1900' for DE). */
async function seedTaxRate(country: string, rate: string): Promise<void> {
  await h.client`
    insert into tax_rates (id, tenant_id, country, region, rate, name)
    values (${newId()}, ${DEFAULT_TENANT_ID}, ${country}, ${null}, ${rate}, ${`VAT ${country}`})
  `;
}

/** Drive a guest cart to checkout shipping to `country`; returns the order id. */
async function placeOrderTo(country: string, qty = 1): Promise<{ id: string }> {
  const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 50 });
  const created = await request(h.http()).post('/store/v1/carts').send({ currency: 'EUR' });
  const cartId = created.body.cartId as string;
  const cookie = extractCartTokenCookie(created);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cookie)
    .send({ variantId, quantity: qty })
    .expect(201);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-address`)
    .set('Cookie', cookie)
    .send({ name: 'Buyer', line1: '1 str', city: 'City', postalCode: '10115', country })
    .expect(200);
  const rates = await request(h.http())
    .get(`/store/v1/carts/${cartId}/shipping-rates`)
    .set('Cookie', cookie);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-method`)
    .set('Cookie', cookie)
    .send({ shippingRateId: rates.body[0].id })
    .expect(200);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/email`)
    .set('Cookie', cookie)
    .send({ email: `buyer-${Date.now()}-${Math.random()}@test.invalid` })
    .expect(200);
  const res = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cookie)
    .send({});
  if (res.status !== 201) {
    throw new Error(`checkout to ${country} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.id as string };
}

const WINDOW = 'from=2000-01-01&to=2999-12-31';
const HEADER =
  'order_number,placed_at,destination_country,line_type,net,vat_rate,vat_amount,currency';

/** Parse the CSV body into a header line + array of {cols} data rows. */
function parseCsv(text: string): { header: string; rows: string[][] } {
  const lines = text.trim().split('\n');
  return { header: lines[0], rows: lines.slice(1).map((l) => l.split(',')) };
}

describe('GET /admin/v1/taxes/oss-export — eu_vat FR origin, above threshold', () => {
  beforeEach(async () => {
    // FR-origin eu_vat tenant, OVER the €10k threshold (charges DESTINATION VAT → OSS).
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      originCountry: 'FR',
      pricesIncludeTax: false,
      ossPosture: 'above_or_opted_in',
    });
    await seedFrDeShipping();
    await seedTaxRate('FR', '0.2000');
    await seedTaxRate('DE', '0.1900');
  });

  it('exports a cross-border (DE) B2C sale as goods + shipping rows but NOT a domestic (FR) one', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    await placeOrderTo('DE'); // cross-border → exported (goods + shipping)
    await placeOrderTo('FR'); // domestic → excluded

    const res = await request(h.http())
      .get(`/admin/v1/taxes/oss-export?${WINDOW}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    const { header, rows } = parseCsv(res.text);
    expect(header).toBe(HEADER);
    // The DE sale → a goods row AND a shipping row. FR domestic → nothing.
    expect(rows).toHaveLength(2);

    // All rows are the DE destination.
    for (const r of rows) expect(r[2]).toBe('DE');

    const goods = rows.find((r) => r[3] === 'goods')!;
    const shipping = rows.find((r) => r[3] === 'shipping')!;
    expect(goods).toBeDefined();
    expect(shipping).toBeDefined();

    // Goods row: net 1000, 19% → 190 (unchanged post-B3).
    expect(goods[4]).toBe('1000');
    expect(Number(goods[6])).toBe(190);
    expect(goods[7]).toBe('EUR');

    // Shipping row: net 500 (tax-exclusive), DE statutory 19% → 95.
    expect(shipping[4]).toBe('500');
    expect(Number(shipping[6])).toBe(95);
    // Shipping carries the SAME destination statutory rate as the goods.
    expect(shipping[5]).toBe(goods[5]);
    expect(shipping[7]).toBe('EUR');

    // Internal consistency: vat == round(net × rate) on each row.
    for (const r of rows) {
      const net = Number(r[4]);
      const rate = Number(r[5]);
      const vat = Number(r[6]);
      expect(Number.isInteger(vat)).toBe(true);
      expect(vat).toBe(Math.round(net * rate));
    }
  });

  it('nets a refund out with a NEGATIVE refund row', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const order = await placeOrderTo('DE');
    // A succeeded refund issued in the window for this cross-border order (net 250 + VAT 50).
    const paymentId = newId();
    await h.client`
      insert into payments (id, tenant_id, order_id, provider, amount, currency, status)
      values (${paymentId}, ${DEFAULT_TENANT_ID}, ${order.id}, 'manual', 1785, 'EUR', 'succeeded')`;
    await h.client`
      insert into refunds (id, tenant_id, order_id, payment_id, amount, currency, tax_amount, status)
      values (${newId()}, ${DEFAULT_TENANT_ID}, ${order.id}, ${paymentId}, 300, 'EUR', 50, 'succeeded')`;

    const res = await request(h.http())
      .get(`/admin/v1/taxes/oss-export?${WINDOW}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    const { rows } = parseCsv(res.text);
    const refundRow = rows.find((r) => r[3] === 'refund');
    expect(refundRow).toBeDefined();
    expect(refundRow![2]).toBe('DE'); // attributed to the order's destination
    expect(Number(refundRow![4])).toBe(-250); // negative net
    expect(Number(refundRow![6])).toBe(-50); // negative VAT
  });

  it('reconciles: Σ exported VAT for the order == order.tax_amount (goods VAT + shipping VAT)', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const order = await placeOrderTo('DE');

    const res = await request(h.http())
      .get(`/admin/v1/taxes/oss-export?${WINDOW}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    const { rows } = parseCsv(res.text);

    const exportedVat = rows.reduce((s, r) => s + Number(r[6]), 0);

    // The shipping VAT == order.tax_amount − Σ goods item tax.
    const [ord] = await h.client`select tax_amount from orders where id = ${order.id}`;
    const items = await h.client`select tax_amount from order_items where order_id = ${order.id}`;
    const goodsVat = items.reduce(
      (s: number, i: { tax_amount: number }) => s + Number(i.tax_amount),
      0,
    );
    const shippingRow = rows.find((r) => r[3] === 'shipping')!;
    expect(Number(shippingRow[6])).toBe(Number(ord.tax_amount) - goodsVat);

    // Σ all exported VAT == the order's total tax.
    expect(exportedVat).toBe(Number(ord.tax_amount));
  });

  it('tax-INCLUSIVE: shipping row net == shipping_amount − shippingVat, reconciles to order tax', async () => {
    // The EU default is VAT-inclusive pricing. Re-seed an above-threshold eu_vat tenant
    // with pricesIncludeTax:true so shipping_amount CONTAINS its VAT (the inclusive branch
    // of shippingNet: shipping_amount − shippingVat).
    await resetOrderState(h);
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      originCountry: 'FR',
      pricesIncludeTax: true,
      ossPosture: 'above_or_opted_in',
    });
    await seedFrDeShipping();
    await seedTaxRate('FR', '0.2000');
    await seedTaxRate('DE', '0.1900');
    const admin = await seedAdminAndLogin(h, 'admin');
    const order = await placeOrderTo('DE');

    const res = await request(h.http())
      .get(`/admin/v1/taxes/oss-export?${WINDOW}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    const { rows } = parseCsv(res.text);

    // Pull the order-level facts straight from the DB to derive the expected inclusive split.
    const [ord] = await h.client`
      select tax_amount, shipping_amount, tax_inclusive from orders where id = ${order.id}
    `;
    expect(ord.tax_inclusive).toBe(true);
    const items = await h.client`select tax_amount from order_items where order_id = ${order.id}`;
    const goodsVat = items.reduce(
      (s: number, i: { tax_amount: number }) => s + Number(i.tax_amount),
      0,
    );

    const shippingRow = rows.find((r) => r[3] === 'shipping')!;
    expect(shippingRow).toBeDefined();

    // shippingVat = order.tax_amount − Σ goods item tax (order-level, clamped ≥ 0).
    const expectedShippingVat = Number(ord.tax_amount) - goodsVat;
    expect(expectedShippingVat).toBeGreaterThan(0);
    expect(Number(shippingRow[6])).toBe(expectedShippingVat);

    // INCLUSIVE branch under test: shipping_amount already contains the VAT, so the
    // reported net is shipping_amount − shippingVat (NOT shipping_amount itself).
    const expectedShippingNet = Number(ord.shipping_amount) - expectedShippingVat;
    expect(Number(shippingRow[4])).toBe(expectedShippingNet);
    // Sanity: an inclusive shipping net is strictly below the gross shipping_amount.
    expect(expectedShippingNet).toBeLessThan(Number(ord.shipping_amount));

    // Shipping carries the goods' destination statutory rate.
    const goodsRow = rows.find((r) => r[3] === 'goods')!;
    expect(shippingRow[5]).toBe(goodsRow[5]);

    // Reconciliation still holds: Σ all exported VAT == order.tax_amount.
    const exportedVat = rows.reduce((s, r) => s + Number(r[6]), 0);
    expect(exportedVat).toBe(Number(ord.tax_amount));
  });

  it('emits NO shipping row when shipping is free / untaxed', async () => {
    // Re-seed with FREE shipping (amount 0) → no shipping VAT → no shipping row.
    await resetOrderState(h);
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      originCountry: 'FR',
      pricesIncludeTax: false,
      ossPosture: 'above_or_opted_in',
    });
    await seedFrDeShipping(0);
    await seedTaxRate('FR', '0.2000');
    await seedTaxRate('DE', '0.1900');
    const admin = await seedAdminAndLogin(h, 'admin');
    await placeOrderTo('DE');

    const res = await request(h.http())
      .get(`/admin/v1/taxes/oss-export?${WINDOW}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    const { rows } = parseCsv(res.text);
    // Goods row only — no shipping row for zero shipping VAT.
    expect(rows.filter((r) => r[3] === 'shipping')).toHaveLength(0);
    expect(rows.filter((r) => r[3] === 'goods')).toHaveLength(1);
  });

  it('excludes a cancelled cross-border sale', async () => {
    const admin = await seedAdminAndLogin(h, 'admin');
    const order = await placeOrderTo('DE');
    await request(h.http())
      .post(`/admin/v1/orders/${order.id}/transitions`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ to: 'cancelled' })
      .expect(200);

    const res = await request(h.http())
      .get(`/admin/v1/taxes/oss-export?${WINDOW}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(parseCsv(res.text).rows).toEqual([]);
  });
});

describe('GET /admin/v1/taxes/oss-export — eu_vat FR origin, below threshold', () => {
  it('returns header-only for a below-threshold tenant (origin-rated, NOT OSS)', async () => {
    // Below threshold: cross-border B2C is charged ORIGIN VAT, declared in the DOMESTIC
    // return — it is NOT an OSS sale and must not appear in the OSS export.
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      originCountry: 'FR',
      pricesIncludeTax: false,
      ossPosture: 'below_threshold',
    });
    await seedFrDeShipping();
    await seedTaxRate('FR', '0.2000');
    await seedTaxRate('DE', '0.1900');
    const admin = await seedAdminAndLogin(h, 'admin');
    await placeOrderTo('DE'); // cross-border, but below threshold → not OSS

    const res = await request(h.http())
      .get(`/admin/v1/taxes/oss-export?${WINDOW}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    const { header, rows } = parseCsv(res.text);
    expect(header).toBe(HEADER);
    expect(rows).toEqual([]); // header only
  });
});

describe('GET /admin/v1/taxes/oss-export — none mode', () => {
  it('returns a header-only (empty) CSV for a non-eu_vat tenant', async () => {
    await setTaxSettings(h, { taxMode: 'none' });
    await seedFrDeShipping();
    const admin = await seedAdminAndLogin(h, 'admin');
    await placeOrderTo('DE'); // would be cross-border, but tenant is not eu_vat

    const res = await request(h.http())
      .get(`/admin/v1/taxes/oss-export?${WINDOW}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    expect(parseCsv(res.text).rows).toEqual([]);
  });
});

describe('GET /admin/v1/taxes/oss-export — tenant isolation', () => {
  it('never leaks another tenant cross-border sale into this tenant export', async () => {
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      originCountry: 'FR',
      pricesIncludeTax: false,
      ossPosture: 'above_or_opted_in',
    });
    await seedFrDeShipping();
    await seedTaxRate('FR', '0.2000');
    await seedTaxRate('DE', '0.1900');
    const admin = await seedAdminAndLogin(h, 'admin');
    await placeOrderTo('DE'); // this tenant's own cross-border sale

    // Forge ANOTHER tenant + an order/items shipped DE, in the same window.
    const otherTenant = newId();
    await h.client`
      insert into tenants (id, name, slug, settings)
      values (${otherTenant}, ${'Other'}, ${`other-${otherTenant}`},
              ${JSON.stringify({ tax_mode: 'eu_vat', oss_posture: 'above_or_opted_in', eu_vat_registration: { origin_country: 'FR' } })}::jsonb)
    `;
    const otherOrder = newId();
    await h.client`
      insert into orders (id, tenant_id, order_number, email, status, currency,
        subtotal_amount, shipping_amount, tax_amount, total_amount, is_b2b, tax_inclusive,
        shipping_address, billing_address, placed_at)
      values (${otherOrder}, ${otherTenant}, ${'OTHER-1'}, ${'x@test.invalid'}, ${'paid'}, ${'EUR'},
        ${2000}, ${500}, ${475}, ${2975}, ${false}, ${false},
        ${JSON.stringify({ country: 'DE' })}::jsonb, ${JSON.stringify({ country: 'DE' })}::jsonb, ${'2024-01-01T00:00:00Z'})
    `;
    await h.client`
      insert into order_items (id, tenant_id, order_id, product_title, sku, quantity,
        unit_price_amount, tax_rate, tax_amount, line_total_amount)
      values (${newId()}, ${otherTenant}, ${otherOrder}, ${'X'}, ${'X'}, ${1},
        ${2000}, ${'0.1900'}, ${380}, ${2380})
    `;

    const res = await request(h.http())
      .get(`/admin/v1/taxes/oss-export?${WINDOW}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    const { rows } = parseCsv(res.text);
    // Only THIS tenant's order rows; no OTHER-1 row.
    expect(rows.every((r) => r[0] !== 'OTHER-1')).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });
});
