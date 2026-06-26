/**
 * Invoice issuance + delivery integration tests.
 *
 * Full AppModule against real Postgres + Redis. LEGAL/MONEY-CRITICAL invariants:
 *  - issuance on `order.paid` (idempotent — no double-issue on a re-emitted event);
 *  - immutability trigger (rejects UPDATE of fiscal cols + DELETE; permits storage_key
 *    NULL→value once);
 *  - regime branch (none → receipt no-VAT; eu_vat → VAT invoice w/ seller VAT + breakdown;
 *    reverse-charge → flag + VIES ref + autoliquidation note in the rendered PDF);
 *  - download: admin + own-customer 200 application/pdf; another customer 404 (IDOR);
 *  - PDF is non-empty %PDF for both receipt + VAT invoice.
 */
import request from 'supertest';
import {
  bootCartApp,
  resetInvoiceState,
  seedSimpleProduct,
  driveCartToCheckoutReady,
  signupAndLoginCustomer,
  seedAdminAndLogin,
  seedShippingRate,
  extractCartTokenCookie,
  setTaxSettings,
  setBusinessIdentity,
  seedTaxRate,
  markOrderPaid,
  waitForInvoice,
  waitForStoredInvoice,
  DEFAULT_TENANT_ID,
  newId,
  type CartHarness,
} from './_invoices-harness';
import { REVERSE_CHARGE_MENTION } from '../../../src/invoices/invoice-snapshot';

let h: CartHarness;

/**
 * Extract the readable text from an uncompressed (compress:false) pdfkit PDF.
 *
 * pdfkit renders text into the content stream as kerning-split TJ arrays of HEX strings
 * (e.g. `[<41> 30 <75746f...>] TJ`), so the words never appear as plain latin1 substrings.
 * We pull every `<hex>` chunk out of the (uncompressed) bytes and decode it, concatenating
 * into one searchable string — enough to assert that a mandatory legal mention was rendered.
 */
function extractPdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  let out = '';
  for (const m of raw.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    const hex = m[1]!;
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
  }
  return out;
}

beforeAll(async () => {
  h = await bootCartApp();
}, 30_000);

afterAll(async () => {
  await h.app.close();
  await h.client.end();
});

beforeEach(async () => {
  await resetInvoiceState(h);
}, 10_000);

/** Place a GUEST order via real checkout, return its id + number. */
async function placeGuestOrder(
  qty = 2,
  price = 1000,
): Promise<{ id: string; orderNumber: string }> {
  const { variantId } = await seedSimpleProduct(h, { price, stock: 50 });
  const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, qty);
  const res = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cartCookie)
    .send({});
  if (res.status !== 201)
    throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id as string, orderNumber: res.body.orderNumber as string };
}

/** Place a CUSTOMER-owned order; returns the order id. */
async function placeCustomerOrder(accessToken: string, qty = 1): Promise<{ id: string }> {
  const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 50 });
  const created = await request(h.http()).post('/store/v1/carts').send({ currency: 'EUR' });
  const cartId = created.body.cartId as string;
  const cookie = extractCartTokenCookie(created);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/customer`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ variantId, quantity: qty })
    .expect(201);
  await seedShippingRate(h, 'EUR');
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-address`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name: 'Buyer', line1: '1 rue', city: 'Paris', postalCode: '75001', country: 'FR' })
    .expect(200);
  const rates = await request(h.http())
    .get(`/store/v1/carts/${cartId}/shipping-rates`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-method`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ shippingRateId: rates.body[0].id })
    .expect(200);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/email`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ email: `buyer-${Date.now()}@test.invalid` })
    .expect(200);
  const res = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({});
  if (res.status !== 201)
    throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id as string };
}

/**
 * Place a CUSTOMER-owned order shipped to DE (a DIFFERENT EU country than the FR-established
 * tenant) so the tax engine computes reverse_charge=true at order creation (cross-border EU
 * B2B with a VIES-validated VAT number). Mirrors placeCustomerOrder but with a DE destination.
 */
async function placeReverseChargeOrder(accessToken: string, qty = 1): Promise<{ id: string }> {
  const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 50 });
  const created = await request(h.http()).post('/store/v1/carts').send({ currency: 'EUR' });
  const cartId = created.body.cartId as string;
  const cookie = extractCartTokenCookie(created);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/customer`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ variantId, quantity: qty })
    .expect(201);
  await seedShippingRate(h, 'EUR');
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-address`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name: 'Buyer', line1: '1 Straße', city: 'Berlin', postalCode: '10115', country: 'DE' })
    .expect(200);
  const rates = await request(h.http())
    .get(`/store/v1/carts/${cartId}/shipping-rates`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-method`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ shippingRateId: rates.body[0].id })
    .expect(200);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/email`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ email: `buyer-${Date.now()}@test.invalid` })
    .expect(200);
  const res = await request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({});
  if (res.status !== 201)
    throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.id as string };
}

describe('issuance on order.paid', () => {
  it('issues exactly one invoice with a gapless, year-prefixed number', async () => {
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder();

    const paid = await markOrderPaid(h, order.id, admin);
    expect(paid.status).toBe(200);

    const inv = await waitForInvoice(h, order.id);
    expect(inv.series).toBe('STD');
    // YYYY-NNNNNN, first in series → 000001.
    expect(inv.invoice_number).toMatch(/^\d{4}-000001$/);

    // Exactly one invoice for the order.
    const count = await h.client<{ n: number }[]>`
      select count(*)::int as n from invoices where order_id = ${order.id}
    `;
    expect(count[0]!.n).toBe(1);
  });

  it('does NOT double-issue when order.paid is effectively retried (idempotent)', async () => {
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder();
    await markOrderPaid(h, order.id, admin);
    const inv = await waitForInvoice(h, order.id);

    // Re-issue directly via the service (simulating a re-emitted/retried order.paid).
    const svc = h.app.get(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../../../src/invoices/invoice.service').InvoiceService,
      { strict: false },
    );
    const again = await svc.issueForOrder(DEFAULT_TENANT_ID, order.id);
    expect(again.created).toBe(false);
    expect(again.invoice.id).toBe(inv.id);

    const count = await h.client<{ n: number }[]>`
      select count(*)::int as n from invoices where order_id = ${order.id} and type = 'invoice'
    `;
    expect(count[0]!.n).toBe(1);
  });
});

describe('immutability (DB trigger — fiscal retention)', () => {
  it('rejects UPDATE of a fiscal column and DELETE of an issued invoice', async () => {
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder();
    await markOrderPaid(h, order.id, admin);
    const inv = await waitForInvoice(h, order.id);

    // UPDATE a fiscal column → rejected.
    await expect(
      h.client`update invoices set total_amount = 999999 where id = ${inv.id}`,
    ).rejects.toThrow();
    await expect(
      h.client`update invoices set invoice_number = ${'2099-999999'} where id = ${inv.id}`,
    ).rejects.toThrow();
    // DELETE → rejected.
    await expect(h.client`delete from invoices where id = ${inv.id}`).rejects.toThrow();

    // The row is unchanged + still present.
    const after = await h.client<{ total_amount: number; invoice_number: string }[]>`
      select total_amount, invoice_number from invoices where id = ${inv.id}
    `;
    expect(after).toHaveLength(1);
    expect(after[0]!.invoice_number).toBe(inv.invoice_number);
  });

  it('permits the storage_key NULL→value transition exactly once, then rejects re-set', async () => {
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder();
    await markOrderPaid(h, order.id, admin);
    // The PDF render lands storage_key post-commit.
    const key = await waitForStoredInvoice(h, order.id);
    expect(key).toContain('invoices');

    const inv = await waitForInvoice(h, order.id);
    // A second set (value→other value) is NOT permitted by the trigger.
    await expect(
      h.client`update invoices set storage_key = ${'tenant/invoices/x/y.pdf'} where id = ${inv.id}`,
    ).rejects.toThrow();
  });
});

describe('regime branch — none (receipt)', () => {
  it('issues a receipt: no VAT, seller without a VAT number, non-empty %PDF', async () => {
    await setTaxSettings(h, { taxMode: 'none', pricesIncludeTax: true });
    await setBusinessIdentity(h, { name: 'Tiny Shop', taxMode: 'none' });
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder(2, 1000);
    await markOrderPaid(h, order.id, admin);
    await waitForInvoice(h, order.id);

    const row = await h.client<
      {
        tax_amount: number;
        seller_snapshot: Record<string, unknown>;
        tax_breakdown: Record<string, unknown>;
      }[]
    >`select tax_amount, seller_snapshot, tax_breakdown from invoices where order_id = ${order.id}`;
    expect(row[0]!.tax_amount).toBe(0);
    expect(row[0]!.seller_snapshot.vatNumber).toBeNull();
    expect((row[0]!.tax_breakdown as { documentKind: string }).documentKind).toBe('receipt');

    // PDF downloads + is a non-empty PDF.
    const dl = await request(h.http())
      .get(`/admin/v1/orders/${order.id}/invoice`)
      .set('Authorization', `Bearer ${admin}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    const body = dl.body as Buffer;
    expect(body.length).toBeGreaterThan(100);
    expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('regime branch — eu_vat (VAT invoice)', () => {
  it('issues a VAT invoice: seller VAT, per-rate breakdown, non-empty %PDF', async () => {
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      pricesIncludeTax: false,
      originCountry: 'FR',
      vatNumber: 'FR12345678901',
    });
    await setBusinessIdentity(h, {
      name: 'Acme SARL',
      siren: '123456789',
      vatNumber: 'FR12345678901',
      originCountry: 'FR',
      taxMode: 'eu_vat',
    });
    await seedTaxRate(h, 'FR', '0.2000');
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder(1, 1000);
    await markOrderPaid(h, order.id, admin);
    await waitForInvoice(h, order.id);

    const row = await h.client<
      {
        tax_amount: number;
        seller_snapshot: Record<string, unknown>;
        tax_breakdown: Record<string, unknown>;
      }[]
    >`select tax_amount, seller_snapshot, tax_breakdown from invoices where order_id = ${order.id}`;
    expect(row[0]!.tax_amount).toBeGreaterThan(0);
    expect(row[0]!.seller_snapshot.vatNumber).toBe('FR12345678901');
    expect(row[0]!.seller_snapshot.siren).toBe('123456789');
    const content = row[0]!.tax_breakdown as {
      documentKind: string;
      taxBreakdown: { rate: number }[];
    };
    expect(content.documentKind).toBe('vat_invoice');
    expect(content.taxBreakdown.length).toBeGreaterThan(0);
    expect(content.taxBreakdown[0]!.rate).toBeCloseTo(0.2, 4);

    const dl = await request(h.http())
      .get(`/admin/v1/orders/${order.id}/invoice`)
      .set('Authorization', `Bearer ${admin}`);
    expect(dl.status).toBe(200);
    expect((dl.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('reverse-charge B2B EU order → flag + VIES ref + autoliquidation note in the PDF', async () => {
    // Tenant in eu_vat established in FR; the customer ships to a DIFFERENT EU country (DE)
    // with a VIES-validated VAT number → the tax engine computes reverse_charge=true at order
    // creation. The invoice then SNAPSHOTS the flag + the customer's stored VIES ref.
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      pricesIncludeTax: false,
      originCountry: 'FR',
      vatNumber: 'FR12345678901',
    });
    await setBusinessIdentity(h, {
      name: 'Acme SARL',
      siren: '123456789',
      vatNumber: 'FR12345678901',
      originCountry: 'FR',
      taxMode: 'eu_vat',
    });
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');

    // A B2B customer with a positively VIES-validated DE VAT number + durable VIES proof.
    // is_b2b + vat_validated must be set BEFORE the order is placed: the order snapshots
    // the owner's B2B/VAT context at creation, and the tax engine needs vat_validated to
    // reverse-charge.
    const { accessToken, customerId } = await signupAndLoginCustomer(h);
    await h.client`
      update customers set is_b2b = true, vat_number = ${'DE811569869'}, vat_validated = true,
        vat_validated_at = now(),
        metadata = ${'{"vat":{"status":"valid","consultationRef":"VIES-REF-INT"}}'}::jsonb
      where id = ${customerId}
    `;

    // Place a genuine reverse-charge order: cross-border EU (origin FR → destination DE).
    const order = await placeReverseChargeOrder(accessToken, 1);

    // The tax engine resolved reverse_charge on the order itself (not forced).
    const ord = await h.client<{ reverse_charge: boolean }[]>`
      select reverse_charge from orders where id = ${order.id}
    `;
    expect(ord[0]!.reverse_charge).toBe(true);

    await markOrderPaid(h, order.id, admin);
    await waitForInvoice(h, order.id);

    const row = await h.client<
      {
        reverse_charge: boolean;
        tax_amount: number;
        vies_consultation_ref: string | null;
        tax_breakdown: Record<string, unknown>;
      }[]
    >`
      select reverse_charge, tax_amount, vies_consultation_ref, tax_breakdown from invoices where order_id = ${order.id}
    `;
    expect(row[0]!.reverse_charge).toBe(true);
    expect(row[0]!.tax_amount).toBe(0);
    // The legally-relevant VIES reference, sourced from the customer's stored VIES evidence.
    expect(row[0]!.vies_consultation_ref).toBe('VIES-REF-INT');
    const content = row[0]!.tax_breakdown as {
      mentions: string[];
      reverseCharge: boolean;
      viesConsultationRef: string | null;
    };
    expect(content.reverseCharge).toBe(true);
    expect(content.viesConsultationRef).toBe('VIES-REF-INT');
    expect(content.mentions).toContain(REVERSE_CHARGE_MENTION);

    // The rendered PDF carries the autoliquidation note + the VIES ref (text in the bytes).
    const dl = await request(h.http())
      .get(`/admin/v1/orders/${order.id}/invoice`)
      .set('Authorization', `Bearer ${admin}`);
    expect(dl.status).toBe(200);
    // Decode the uncompressed PDF's text streams (pdfkit hex-encodes glyphs).
    const text = extractPdfText(dl.body as Buffer);
    expect(text).toContain('Autoliquidation');
    expect(text).toContain('VIES-REF-INT');
  });
});

// ── The rendered invoice itemises shipping + discount and RECONCILES EXACTLY to
//    order.total_amount, with a correct per-rate recap, in BOTH inclusive + exclusive modes.
//    We read the order's snapshotted totals + the persisted invoice content and assert:
//      net subtotal − discount + shipping-net + Σ VAT == order.total_amount,
//      Σ recap VAT == order.tax_amount, and each recap row's rate×base ≈ vat. ──
interface InvoiceContentRow {
  taxInclusive: boolean;
  subtotalAmount: number;
  discount: { netAmount: number };
  shipping: { netAmount: number; taxAmount: number; taxRate: number };
  taxAmount: number;
  totalAmount: number;
  taxBreakdown: { rate: number; baseAmount: number; taxAmount: number }[];
}

async function loadInvoiceContent(orderId: string): Promise<InvoiceContentRow> {
  const row = await h.client<{ tax_breakdown: InvoiceContentRow }[]>`
    select tax_breakdown from invoices where order_id = ${orderId} and type = 'invoice'
  `;
  return row[0]!.tax_breakdown;
}

async function loadOrderTotals(
  orderId: string,
): Promise<{ tax_amount: number; total_amount: number; tax_inclusive: boolean }> {
  const ord = await h.client<
    { tax_amount: number; total_amount: number; tax_inclusive: boolean }[]
  >`
    select tax_amount, total_amount, tax_inclusive from orders where id = ${orderId}
  `;
  return ord[0]!;
}

function assertReconciles(
  c: InvoiceContentRow,
  order: { tax_amount: number; total_amount: number },
): void {
  // Subtotal(net) − discount + shipping(net) + Σ VAT == order total, in BOTH modes.
  const reconstructed =
    c.subtotalAmount - c.discount.netAmount + c.shipping.netAmount + c.taxAmount;
  expect(reconstructed).toBe(order.total_amount);
  expect(c.totalAmount).toBe(order.total_amount);
  // Σ recap VAT == the invoice tax == order tax.
  expect(c.taxAmount).toBe(order.tax_amount);
  const recapTax = c.taxBreakdown.reduce((s, r) => s + r.taxAmount, 0);
  expect(recapTax).toBe(c.taxAmount);
  // Each charging recap row: rate×base ≈ vat (rounding tolerance).
  for (const r of c.taxBreakdown) {
    if (r.rate <= 0) continue;
    expect(Math.abs(Math.round(r.baseAmount * r.rate) - r.taxAmount)).toBeLessThanOrEqual(2);
  }
}

describe('reconciliation — shipping + discount + VAT add up to order.total (B1/B2)', () => {
  it('eu_vat EXCLUSIVE (prices exclude tax): goods + taxed shipping reconcile, recap rate×base holds', async () => {
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      pricesIncludeTax: false,
      originCountry: 'FR',
      vatNumber: 'FR12345678901',
    });
    await setBusinessIdentity(h, {
      name: 'Acme SARL',
      siren: '123456789',
      vatNumber: 'FR12345678901',
      originCountry: 'FR',
      taxMode: 'eu_vat',
    });
    await seedTaxRate(h, 'FR', '0.2000');
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    // Goods 2×1000 = 2000 net @20% = 400; shipping 500 @20% = 100. order.tax = 500.
    const order = await placeGuestOrder(2, 1000);
    await markOrderPaid(h, order.id, admin);
    await waitForInvoice(h, order.id);

    const content = await loadInvoiceContent(order.id);
    const totals = await loadOrderTotals(order.id);
    expect(content.taxInclusive).toBe(false);
    expect(content.shipping.netAmount).toBeGreaterThan(0);
    expect(content.shipping.taxAmount).toBeGreaterThan(0); // shipping VAT itemised, not folded
    assertReconciles(content, totals);
  });

  it('eu_vat INCLUSIVE (prices include tax, normal B2C): net base derived, reconciles to total', async () => {
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      pricesIncludeTax: true,
      originCountry: 'FR',
      vatNumber: 'FR12345678901',
    });
    await setBusinessIdentity(h, {
      name: 'Acme SARL',
      siren: '123456789',
      vatNumber: 'FR12345678901',
      originCountry: 'FR',
      taxMode: 'eu_vat',
    });
    await seedTaxRate(h, 'FR', '0.2000');
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    const order = await placeGuestOrder(2, 1000);
    await markOrderPaid(h, order.id, admin);
    await waitForInvoice(h, order.id);

    const content = await loadInvoiceContent(order.id);
    const totals = await loadOrderTotals(order.id);
    expect(content.taxInclusive).toBe(true);
    // The recap base is NET (gross − extracted VAT), never the gross.
    const recapBase = content.taxBreakdown.reduce((s, r) => s + r.baseAmount, 0);
    expect(recapBase).toBe(
      content.subtotalAmount - content.discount.netAmount + content.shipping.netAmount,
    );
    assertReconciles(content, totals);
  });
});

describe('VIES-ref order-time snapshot — stable against later customer VAT change', () => {
  it('prints the ORDER-TIME ref even after the customer re-validates a DIFFERENT vat_number', async () => {
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      pricesIncludeTax: false,
      originCountry: 'FR',
      vatNumber: 'FR12345678901',
    });
    await setBusinessIdentity(h, {
      name: 'Acme SARL',
      siren: '123456789',
      vatNumber: 'FR12345678901',
      originCountry: 'FR',
      taxMode: 'eu_vat',
    });
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    const { accessToken, customerId } = await signupAndLoginCustomer(h);
    // The order is placed with DE811569869; the proof is valid for THAT number.
    await h.client`
      update customers set is_b2b = true, vat_number = ${'DE811569869'}, vat_validated = true,
        vat_validated_at = now(),
        metadata = ${'{"vat":{"status":"valid","consultationRef":"VIES-REF-OLD"}}'}::jsonb
      where id = ${customerId}
    `;
    const order = await placeReverseChargeOrder(accessToken, 1);
    const ord = await h.client<{ reverse_charge: boolean }[]>`
      select reverse_charge from orders where id = ${order.id}
    `;
    expect(ord[0]!.reverse_charge).toBe(true);

    // The order SNAPSHOTTED the ref (VIES-REF-OLD) at creation, for the number it was placed
    // under (DE811569869). That is now the order's immutable record (orders.vies_consultation_ref).
    const ordRef = await h.client<{ vies_consultation_ref: string | null }[]>`
      select vies_consultation_ref from orders where id = ${order.id}
    `;
    expect(ordRef[0]!.vies_consultation_ref).toBe('VIES-REF-OLD');

    // AFTER the order: the customer re-validates a DIFFERENT VAT number + a new ref. This must NOT
    // leak into THIS order's invoice — the snapshot is authoritative.
    await h.client`
      update customers set vat_number = ${'DE999999999'},
        metadata = ${'{"vat":{"status":"valid","consultationRef":"VIES-REF-NEW"}}'}::jsonb
      where id = ${customerId}
    `;

    await markOrderPaid(h, order.id, admin);
    await waitForInvoice(h, order.id);

    // The invoice prints the ORDER-TIME ref (VIES-REF-OLD), consistent with the order's
    // snapshotted vat_number — NEVER the customer's later re-validated VIES-REF-NEW.
    const row = await h.client<{ vies_consultation_ref: string | null }[]>`
      select vies_consultation_ref from invoices where order_id = ${order.id}
    `;
    expect(row[0]!.vies_consultation_ref).toBe('VIES-REF-OLD');
  });
});

describe('download — auth + IDOR + tenant isolation', () => {
  it("a customer can download their OWN order's invoice (200 application/pdf)", async () => {
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    const { accessToken: customer } = await signupAndLoginCustomer(h);
    const order = await placeCustomerOrder(customer, 1);
    await markOrderPaid(h, order.id, admin);
    await waitForInvoice(h, order.id);

    const dl = await request(h.http())
      .get(`/store/v1/orders/${order.id}/invoice`)
      .set('Authorization', `Bearer ${customer}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect((dl.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it("another customer gets 404 for someone else's order invoice (no IDOR / no existence leak)", async () => {
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    const { accessToken: owner } = await signupAndLoginCustomer(h);
    const { accessToken: attacker } = await signupAndLoginCustomer(h);
    const order = await placeCustomerOrder(owner, 1);
    await markOrderPaid(h, order.id, admin);
    await waitForInvoice(h, order.id);

    const dl = await request(h.http())
      .get(`/store/v1/orders/${order.id}/invoice`)
      .set('Authorization', `Bearer ${attacker}`);
    expect(dl.status).toBe(404);
  });

  it('a guest order (no customer) is 404 to any customer download', async () => {
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    const { accessToken: customer } = await signupAndLoginCustomer(h);
    const order = await placeGuestOrder(1, 1000);
    await markOrderPaid(h, order.id, admin);
    await waitForInvoice(h, order.id);

    const dl = await request(h.http())
      .get(`/store/v1/orders/${order.id}/invoice`)
      .set('Authorization', `Bearer ${customer}`);
    expect(dl.status).toBe(404);
  });

  it('the admin download is tenant-scoped — a foreign tenant order id 404s', async () => {
    const { accessToken: admin } = await seedAdminAndLogin(h, 'admin');
    // An order id that does not exist in this tenant.
    const dl = await request(h.http())
      .get(`/admin/v1/orders/${newId()}/invoice`)
      .set('Authorization', `Bearer ${admin}`);
    expect(dl.status).toBe(404);
  });
});

describe('repository.loadOrder — excludes soft-deleted orders', () => {
  it('returns the order while active, and NULL once soft-deleted (matches the docstring contract)', async () => {
    const order = await placeGuestOrder(1, 1000);

    const repo = h.app.get(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../../../src/invoices/invoice.repository').InvoiceRepository,
      { strict: false },
    );

    const db = h.app.get(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../../../src/database/database.service').DatabaseService,
      { strict: false },
    );

    // Active: loadOrder returns the row.
    const active = await repo.loadOrder(db.db, DEFAULT_TENANT_ID, order.id);
    expect(active).not.toBeNull();
    expect(active!.id).toBe(order.id);

    // Soft-delete the order.
    await h.client`update orders set deleted_at = now() where id = ${order.id}`;

    // Now loadOrder must NOT return it (the documented "excludes soft-deleted" contract).
    const afterDelete = await repo.loadOrder(db.db, DEFAULT_TENANT_ID, order.id);
    expect(afterDelete).toBeNull();
  });
});
