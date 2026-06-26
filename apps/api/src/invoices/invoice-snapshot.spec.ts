/**
 * invoice snapshot builder unit tests.
 *
 * The snapshot is the immutable, rendered content of an invoice. These tests pin the
 * regime branch (receipt vs VAT invoice), the per-rate breakdown, the reverse-charge
 * autoliquidation mention, and the MONEY RECONCILIATION: the invoice itemises shipping
 * + discount and reconciles EXACTLY to order.total_amount, with a correct per-rate VAT
 * recap (rate×base≈vat), in BOTH tax-inclusive and exclusive modes. These are the
 * legal/money invariants.
 */
import {
  buildInvoiceContent,
  REVERSE_CHARGE_MENTION,
  type OrderForInvoice,
  type OrderItemForInvoice,
  type SellerIdentity,
} from './invoice-snapshot';

const SELLER_EU: SellerIdentity = {
  name: 'Acme SARL',
  address: {
    name: 'Acme SARL',
    line1: '10 rue du Commerce',
    city: 'Paris',
    postalCode: '75001',
    country: 'FR',
  },
  country: 'FR',
  siren: '123456789',
  vatNumber: 'FR12345678901',
};

const SELLER_NONE: SellerIdentity = {
  name: 'Tiny Shop',
  address: {
    name: 'Tiny Shop',
    line1: '1 High St',
    city: 'Town',
    postalCode: 'AB1',
    country: 'FR',
  },
  country: null,
  siren: null,
  vatNumber: null,
};

function baseOrder(overrides: Partial<OrderForInvoice> = {}): OrderForInvoice {
  return {
    email: 'buyer@example.com',
    currency: 'EUR',
    subtotalAmount: 1000,
    discountAmount: 0,
    shippingAmount: 0,
    taxAmount: 0,
    totalAmount: 1000,
    taxInclusive: false,
    isB2b: false,
    vatNumber: null,
    reverseCharge: false,
    billingAddress: {
      name: 'Jane Buyer',
      line1: '2 Customer Way',
      city: 'Lyon',
      postalCode: '69001',
      country: 'FR',
    },
    viesConsultationRef: null,
    ...overrides,
  };
}

function item(overrides: Partial<OrderItemForInvoice> = {}): OrderItemForInvoice {
  return {
    productTitle: 'Widget',
    variantTitle: 'Blue',
    sku: 'WID-1',
    quantity: 2,
    unitPriceAmount: 500,
    taxRate: '0.0000',
    taxAmount: 0,
    lineTotalAmount: 1000,
    ...overrides,
  };
}

/** The reconciliation invariant the invoice MUST satisfy in BOTH modes. */
function expectReconciles(
  content: ReturnType<typeof buildInvoiceContent>,
  order: OrderForInvoice,
): void {
  const reconstructed =
    content.subtotalAmount -
    content.discount.netAmount +
    content.shipping.netAmount +
    content.taxAmount;
  expect(reconstructed).toBe(order.totalAmount);
  expect(content.totalAmount).toBe(order.totalAmount);
  // Per-rate recap totals the order VAT, and each charging row satisfies rate×base ≈ vat.
  const recapTax = content.taxBreakdown.reduce((s, r) => s + r.taxAmount, 0);
  if (content.taxBreakdown.length > 0) expect(recapTax).toBe(content.taxAmount);
  for (const row of content.taxBreakdown) {
    if (row.rate <= 0) continue;
    expect(Math.abs(Math.round(row.baseAmount * row.rate) - row.taxAmount)).toBeLessThanOrEqual(2);
  }
}

describe('buildInvoiceContent — none mode (receipt)', () => {
  it('produces a receipt with NO VAT lines and a seller without a VAT number', () => {
    const content = buildInvoiceContent('none', baseOrder(), [item()], SELLER_NONE);

    expect(content.documentKind).toBe('receipt');
    expect(content.taxAmount).toBe(0);
    expect(content.taxBreakdown).toEqual([]);
    expect(content.lines[0]!.taxRate).toBe(0);
    expect(content.lines[0]!.lineTaxAmount).toBe(0);
    expect(content.lines[0]!.lineNetAmount).toBe(1000);
    expect(content.totalAmount).toBe(1000);
  });

  it('none-mode shows NO VAT lines/breakdown even if an order line carried a tax rate', () => {
    // A none-regime order does not charge VAT (order.tax 0); the receipt strips any per-line
    // tax label. Line amounts are shown gross-of-nothing (there is no VAT to extract).
    const order = baseOrder({ taxAmount: 0, totalAmount: 1000 });
    const content = buildInvoiceContent(
      'none',
      order,
      [item({ taxRate: '0.2000', taxAmount: 0 })],
      SELLER_NONE,
    );
    expect(content.taxAmount).toBe(0);
    expect(content.lines[0]!.taxRate).toBe(0);
    expect(content.lines[0]!.lineTaxAmount).toBe(0);
    expect(content.taxBreakdown).toEqual([]);
    expectReconciles(content, order);
  });

  it('a receipt with shipping + discount itemises both and reconciles', () => {
    // subtotal 1000, discount 100 → line net-after-discount 900, shipping 300, no tax → total 1200.
    const order = baseOrder({ discountAmount: 100, shippingAmount: 300, totalAmount: 1200 });
    const content = buildInvoiceContent(
      'none',
      order,
      [item({ lineTotalAmount: 900 })],
      SELLER_NONE,
    );
    expect(content.discount.netAmount).toBe(100);
    expect(content.subtotalAmount).toBe(1000); // pre-discount
    expect(content.shipping.netAmount).toBe(300);
    expect(content.shipping.taxAmount).toBe(0);
    expectReconciles(content, order);
  });
});

describe('buildInvoiceContent — eu_vat exclusive (VAT added on top)', () => {
  it('goods only: per-rate breakdown, seller VAT number, reconciles', () => {
    // Exclusive: net 1000 @20% → tax 200 added on top → total 1200. lineTotal = net+tax = 1200.
    const order = baseOrder({ taxAmount: 200, totalAmount: 1200 });
    const content = buildInvoiceContent(
      'eu_vat',
      order,
      [item({ taxRate: '0.2000', taxAmount: 200, lineTotalAmount: 1200 })],
      SELLER_EU,
    );

    expect(content.documentKind).toBe('vat_invoice');
    expect(content.taxInclusive).toBe(false);
    expect(content.taxAmount).toBe(200);
    expect(content.lines[0]!.taxRate).toBeCloseTo(0.2, 4);
    expect(content.lines[0]!.lineTaxAmount).toBe(200);
    expect(content.lines[0]!.lineNetAmount).toBe(1000);
    expect(content.taxBreakdown).toHaveLength(1);
    expect(content.taxBreakdown[0]).toMatchObject({ baseAmount: 1000, taxAmount: 200 });
    expect(content.taxBreakdown[0]!.rate).toBeCloseTo(0.2, 4);
    expect(content.reverseCharge).toBe(false);
    expectReconciles(content, order);
  });

  it('goods + DISCOUNT + taxed SHIPPING: itemises shipping as its OWN correctly-rated row', () => {
    // Exclusive. Pre-discount goods net 1000, discount 100 (net) → net-after-discount 900.
    // Items tax @20% on 900 = 180. Shipping net 300 @20% = 60. order.tax = 180+60 = 240.
    // total = 1000 − 100 + 300 + 240 = 1440. line: items.tax_amount=180 is the line items-tax
    // share; shipping tax is the order-level remainder (order.tax − Σ line tax = 240−180 = 60).
    const order = baseOrder({
      subtotalAmount: 1000,
      discountAmount: 100,
      shippingAmount: 300,
      taxAmount: 240,
      totalAmount: 1440,
    });
    const content = buildInvoiceContent(
      'eu_vat',
      order,
      // line net (ex-VAT) after discount = lineTotal − tax. exclusive lineTotal = net+tax = 900+180.
      [item({ taxRate: '0.2000', taxAmount: 180, lineTotalAmount: 1080 })],
      SELLER_EU,
    );

    expect(content.discount.netAmount).toBe(100);
    expect(content.shipping.netAmount).toBe(300);
    expect(content.shipping.taxAmount).toBe(60);
    expect(content.shipping.taxRate).toBeCloseTo(0.2, 4);
    // Subtotal is the NET goods BEFORE discount (so Subtotal − Discount == line nets).
    expect(content.subtotalAmount).toBe(1000);
    expect(content.taxAmount).toBe(240);
    // ONE 20% row (goods-after-discount + shipping merge): base 900+300=1200, vat 180+60=240.
    expect(content.taxBreakdown).toHaveLength(1);
    expect(content.taxBreakdown[0]).toMatchObject({ baseAmount: 1200, taxAmount: 240 });
    expect(content.taxBreakdown[0]!.rate).toBeCloseTo(0.2, 4);
    expectReconciles(content, order);
  });

  it('does NOT fold shipping VAT into a goods row in a way that breaks rate×base (old B1 bug)', () => {
    // The OLD code took goods 1000 net @20% (200) and FOLDED 100 of shipping tax into the same
    // 20% row → 20% on base 1000 = tax 300 (rate×base broken). The fix gives shipping its own
    // net base so the merged row is 20% on (1000 + shipping-net) and rate×base holds.
    // Goods net 1000 @20%=200; shipping net 500 @20%=100; order.tax=300; total=1000+500+300=1800.
    const order = baseOrder({
      shippingAmount: 500,
      taxAmount: 300,
      totalAmount: 1800,
    });
    const content = buildInvoiceContent(
      'eu_vat',
      order,
      [item({ taxRate: '0.2000', taxAmount: 200, lineTotalAmount: 1200 })],
      SELLER_EU,
    );
    expect(content.taxBreakdown).toHaveLength(1);
    const row = content.taxBreakdown[0]!;
    // The merged 20% row: base = goods 1000 + shipping 500 = 1500, vat = 300. rate×base holds.
    expect(row).toMatchObject({ baseAmount: 1500, taxAmount: 300 });
    expect(Math.round(row.baseAmount * row.rate)).toBe(row.taxAmount); // 20% × 1500 = 300 ✓
    expectReconciles(content, order);
  });
});

describe('buildInvoiceContent — eu_vat inclusive (B2C, VAT extracted from gross)', () => {
  it('derives the NET base from gross − extracted VAT; recap base is net; reconciles', () => {
    // Inclusive: line prices are GROSS. Gross goods 1200 contains 200 VAT @20% → net 1000.
    // No shipping/discount. order.subtotal(gross)=1200, tax=200, total=1200 (VAT not re-added).
    const order = baseOrder({
      subtotalAmount: 1200,
      taxAmount: 200,
      totalAmount: 1200,
      taxInclusive: true,
    });
    const content = buildInvoiceContent(
      'eu_vat',
      order,
      // inclusive lineTotal = gross-after-discount = 1200; line VAT share = 200 → net = 1000.
      [item({ taxRate: '0.2000', taxAmount: 200, lineTotalAmount: 1200 })],
      SELLER_EU,
    );

    expect(content.taxInclusive).toBe(true);
    // The NET base, NOT the gross.
    expect(content.subtotalAmount).toBe(1000);
    expect(content.lines[0]!.lineNetAmount).toBe(1000);
    expect(content.taxAmount).toBe(200);
    expect(content.taxBreakdown).toHaveLength(1);
    expect(content.taxBreakdown[0]).toMatchObject({ baseAmount: 1000, taxAmount: 200 });
    // total printed == order total; net + VAT == gross == total.
    expect(content.totalAmount).toBe(1200);
    expectReconciles(content, order);
  });

  it('inclusive + taxed shipping + discount: net base everywhere, reconciles to order total', () => {
    // Inclusive @20%. Gross goods (pre-discount) 1200; gross discount 120 → gross-after 1080,
    // net 900 (round(1080/1.2)), items VAT 180. Gross shipping 360 → net 300, VAT 60.
    // order.tax = 180+60 = 240. order.total(inclusive) = subtotal(gross) − discount + shipping(gross)
    //   = 1200 − 120 + 360 = 1440. Discount net = round(120/1.2) = 100 → subtotal pre-discount net 1000.
    const order = baseOrder({
      subtotalAmount: 1200,
      discountAmount: 120,
      shippingAmount: 360,
      taxAmount: 240,
      totalAmount: 1440,
      taxInclusive: true,
    });
    const content = buildInvoiceContent(
      'eu_vat',
      order,
      // inclusive lineTotal = gross-after-discount = 1080; line VAT share = 180 → net = 900.
      [item({ taxRate: '0.2000', taxAmount: 180, lineTotalAmount: 1080 })],
      SELLER_EU,
    );
    expect(content.subtotalAmount).toBe(1000); // NET, pre-discount
    expect(content.lines[0]!.lineNetAmount).toBe(900); // NET after discount
    expect(content.shipping.netAmount).toBe(300);
    expect(content.shipping.taxAmount).toBe(60);
    expect(content.discount.netAmount).toBe(100); // VAT extracted from the gross discount
    expect(content.taxAmount).toBe(240);
    // Recap base is NET (900 goods-after-discount + 300 shipping = 1200) @20% → 240.
    expect(content.taxBreakdown).toHaveLength(1);
    expect(content.taxBreakdown[0]).toMatchObject({ baseAmount: 1200, taxAmount: 240 });
    expectReconciles(content, order);
  });
});

describe('buildInvoiceContent — reverse charge (autoliquidation)', () => {
  it('reverse-charge → flag, 0 tax, VIES ref, the mention, and a single 0% recap row', () => {
    const order = baseOrder({
      taxAmount: 0,
      totalAmount: 1000,
      isB2b: true,
      reverseCharge: true,
      vatNumber: 'DE811569869',
      viesConsultationRef: 'VIES-REF-XYZ',
    });
    const content = buildInvoiceContent(
      'eu_vat',
      order,
      [item({ taxRate: '0.0000', taxAmount: 0 })],
      SELLER_EU,
    );

    expect(content.reverseCharge).toBe(true);
    expect(content.taxAmount).toBe(0);
    expect(content.lines[0]!.lineTaxAmount).toBe(0);
    expect(content.viesConsultationRef).toBe('VIES-REF-XYZ');
    expect(content.mentions).toContain(REVERSE_CHARGE_MENTION);
    expect(content.taxBreakdown).toEqual([{ rate: 0, baseAmount: 1000, taxAmount: 0 }]);
    expectReconciles(content, order);
  });
});

describe('buildInvoiceContent — reconciliation guard', () => {
  it('THROWS when the figures do not sum to order.total_amount (money-integrity guard)', () => {
    // A deliberately inconsistent order: total claims 9999 but the parts sum to 1200.
    const order = baseOrder({ taxAmount: 200, totalAmount: 9999 });
    expect(() =>
      buildInvoiceContent(
        'eu_vat',
        order,
        [item({ taxRate: '0.2000', taxAmount: 200 })],
        SELLER_EU,
      ),
    ).toThrow(/reconcile failed/);
  });
});
