/**
 * Unit tests for order-snapshot + totals recompute.
 *
 * The reconciliation guard is the money invariant: per-line tax/goods must sum exactly
 * to the order totals, with no rounding drift. Largest-remainder apportionment is the
 * mechanism; these tests pin it.
 */
import {
  apportion,
  buildSnapshot,
  type SnapshotLineInput,
  type TaxBreakdown,
} from './order-snapshot';
import { taxBreakdownFromResult } from './orders.service';
import { EuVatResolver } from '../taxes/engine/eu-vat-resolver';

/** A no-VAT breakdown (tax 'none' regime). */
const NO_TAX: TaxBreakdown = { itemsTax: 0, itemsRate: 0, shippingTax: 0 };
/** Build a breakdown from items tax + statutory rate (+ optional shipping tax). */
const tax = (itemsTax: number, itemsRate: number, shippingTax = 0): TaxBreakdown => ({
  itemsTax,
  itemsRate,
  shippingTax,
});

describe('apportion', () => {
  it('sums exactly to the total', () => {
    const out = apportion(100, [1, 1, 1]);
    expect(out.reduce((s, x) => s + x, 0)).toBe(100);
  });

  it('distributes leftover units to the largest fractional parts', () => {
    // 10 split over [1,1,1] → 3.33 each; remainder 1 goes to the first largest frac.
    const out = apportion(10, [1, 1, 1]);
    expect(out.reduce((s, x) => s + x, 0)).toBe(10);
    expect(out.filter((x) => x === 4).length).toBe(1);
    expect(out.filter((x) => x === 3).length).toBe(2);
  });

  it('returns all zeros when total is 0', () => {
    expect(apportion(0, [3, 5, 2])).toEqual([0, 0, 0]);
  });

  it('returns all zeros when every weight is 0', () => {
    expect(apportion(50, [0, 0])).toEqual([0, 0]);
  });

  it('weights proportionally', () => {
    const out = apportion(100, [3, 1]); // 75 / 25
    expect(out).toEqual([75, 25]);
  });
});

const line = (over: Partial<SnapshotLineInput> = {}): SnapshotLineInput => ({
  variantId: 'v1',
  productTitle: 'P',
  variantTitle: null,
  sku: 'SKU',
  quantity: 1,
  unitPriceAmount: 1000,
  ...over,
});

describe('buildSnapshot — tax-exclusive', () => {
  it('adds tax on top and reconciles line tax to the total', () => {
    const inputs = [line({ unitPriceAmount: 1000, quantity: 2 }), line({ unitPriceAmount: 500 })];
    // subtotal 2500, no discount, 20% items tax = 500 added on top, shipping 300 (untaxed).
    const { lines, totals } = buildSnapshot(inputs, 0, tax(500, 0.2), 300, false);
    expect(totals.subtotalAmount).toBe(2500);
    expect(totals.discountAmount).toBe(0);
    expect(totals.taxAmount).toBe(500);
    expect(totals.shippingAmount).toBe(300);
    expect(totals.totalAmount).toBe(2500 - 0 + 300 + 500);
    expect(lines.reduce((s, l) => s + l.taxAmount, 0)).toBe(500);
    // line goods (net) sums to subtotal − discount.
    expect(lines.reduce((s, l) => s + (l.lineTotalAmount - l.taxAmount), 0)).toBe(2500);
    // Every per-line rate is the STATUTORY 0.2 (not a blended ratio).
    expect(lines.every((l) => l.taxRate === 0.2)).toBe(true);
  });

  it('apportions a discount across lines and keeps tax on the net base', () => {
    const inputs = [line({ unitPriceAmount: 1000, quantity: 1 }), line({ unitPriceAmount: 3000 })];
    // subtotal 4000, discount 400 (→ net 3600), 20% of 3600 = 720 items tax, no shipping.
    const { lines, totals } = buildSnapshot(inputs, 400, tax(720, 0.2), 0, false);
    expect(totals.discountAmount).toBe(400);
    expect(totals.taxAmount).toBe(720);
    expect(totals.totalAmount).toBe(4000 - 400 + 0 + 720);
    expect(lines.reduce((s, l) => s + l.taxAmount, 0)).toBe(720);
  });
});

describe('buildSnapshot — tax-inclusive', () => {
  it('does NOT add tax to the grand total (already inside prices)', () => {
    const inputs = [line({ unitPriceAmount: 1200 })];
    // gross 1200, items tax 200 already inside, shipping 0.
    const { lines, totals } = buildSnapshot(inputs, 0, tax(200, 0.2), 0, true);
    expect(totals.taxAmount).toBe(200);
    expect(totals.totalAmount).toBe(1200); // tax not added again
    // inclusive lineTotal excludes the per-line tax add-on (it's already in the price).
    expect(lines[0]!.lineTotalAmount).toBe(1200);
    expect(lines[0]!.taxAmount).toBe(200);
  });
});

describe('buildSnapshot — tax-inclusive reverse charge / zero-rated export', () => {
  it('books the NET total, not the gross, when the embedded VAT is stripped', () => {
    // gross sticker 12000 incl 20%; reverse charge → 0 VAT charged, but the embedded
    // 2000 must be removed from the inclusive grand total. itemsRate 0, itemsTax 0, but
    // inclusiveItemsNet=10000 tells the snapshot the booked net.
    const inputs = [line({ unitPriceAmount: 12000 })];
    const { lines, totals } = buildSnapshot(
      inputs,
      0,
      { itemsTax: 0, itemsRate: 0, shippingTax: 0, inclusiveItemsNet: 10000 },
      0,
      true,
    );
    expect(totals.taxAmount).toBe(0);
    expect(totals.totalAmount).toBe(10000); // NET, not the 12000 gross
    expect(totals.subtotalAmount).toBe(10000); // subtotal reflects the net booked
    expect(lines[0]!.lineTotalAmount).toBe(10000);
    expect(lines[0]!.taxAmount).toBe(0);
  });

  it('strips embedded shipping VAT too (inclusiveShippingNet)', () => {
    const inputs = [line({ unitPriceAmount: 12000 })];
    // shipping gross 1200 incl 20% → net 1000.
    const { totals } = buildSnapshot(
      inputs,
      0,
      {
        itemsTax: 0,
        itemsRate: 0,
        shippingTax: 0,
        inclusiveItemsNet: 10000,
        inclusiveShippingNet: 1000,
      },
      1200,
      true,
    );
    expect(totals.shippingAmount).toBe(1000); // net shipping
    expect(totals.totalAmount).toBe(11000); // 10000 + 1000, no VAT
  });

  it('the NORMAL inclusive B2C path is unchanged (no inclusiveItemsNet → keep gross)', () => {
    const inputs = [line({ unitPriceAmount: 1200 })];
    const { totals } = buildSnapshot(inputs, 0, tax(200, 0.2), 0, true);
    expect(totals.totalAmount).toBe(1200); // gross kept — VAT genuinely embedded & charged
  });
});

// End-to-end wiring: an INCLUSIVE B2B cross-border reverse-charge order books the NET total, NOT
// the gross sticker price — resolver strips embedded VAT → taxBreakdownFromResult carries
// the net → buildSnapshot books it.
describe('inclusive reverse-charge order total is NET (resolver → breakdown → snapshot)', () => {
  it('gross 12000 sticker @20% reverse charge → order total 10000 (net), tax 0', () => {
    const resolver = new EuVatResolver({
      originCountry: 'FR',
      ossPosture: 'below_threshold',
      destinationRate: 0.2, // DE would-be rate
      originRate: 0.2,
    });
    const taxResult = resolver.resolve({
      currency: 'EUR',
      destinationCountry: 'DE',
      components: [{ description: 'Items', amount: 12000 }], // gross incl 20% VAT
      pricesIncludeTax: true,
      customer: { isB2b: true, vatValidated: true },
    });
    expect(taxResult.lines[0]).toMatchObject({ base: 10000, amount: 0, reverseCharge: true });

    const breakdown = taxBreakdownFromResult(taxResult, /* taxInclusive */ true);
    expect(breakdown.inclusiveItemsNet).toBe(10000);

    const { totals } = buildSnapshot(
      [line({ unitPriceAmount: 12000 })],
      0,
      breakdown,
      0,
      /* taxInclusive */ true,
    );
    expect(totals.taxAmount).toBe(0);
    expect(totals.totalAmount).toBe(10000); // NET booked, not the 12000 gross
  });
});

describe('buildSnapshot — guards', () => {
  it('clamps a discount larger than the subtotal', () => {
    const { totals } = buildSnapshot([line({ unitPriceAmount: 1000 })], 5000, NO_TAX, 0, false);
    expect(totals.discountAmount).toBe(1000);
    expect(totals.totalAmount).toBe(0);
  });

  it('handles an exact penny split with no drift (largest-remainder)', () => {
    const inputs = [
      line({ unitPriceAmount: 333 }),
      line({ unitPriceAmount: 333 }),
      line({ unitPriceAmount: 334 }),
    ];
    // subtotal 1000, 10% items tax = 100 (exclusive).
    const { lines, totals } = buildSnapshot(inputs, 0, tax(100, 0.1), 0, false);
    expect(totals.taxAmount).toBe(100);
    expect(lines.reduce((s, l) => s + l.taxAmount, 0)).toBe(100);
  });
});

// ── Shipping VAT must NOT smear into per-line goods tax, and the
//    per-line rate is the statutory fraction (never a blended ratio that overflows). ──
describe('buildSnapshot — taxed shipping does not smear into goods lines (B3)', () => {
  it('cheap item + expensive taxed shipping → statutory line rate, no numeric overflow', () => {
    // FR 20%: one 50c item, shipping €30 (3000). Items tax = round(50*0.2)=10; shipping
    // tax = round(3000*0.2)=600. The OLD code smeared (10+600)=610 over a 50c net line →
    // rate 610/50 = 12.2 > numeric(5,4) max → INSERT 500. The fix keeps rate = 0.2000.
    const inputs = [line({ unitPriceAmount: 50, quantity: 1 })];
    const { lines, totals } = buildSnapshot(inputs, 0, tax(10, 0.2, 600), 3000, false);

    // Per-line rate is the STATUTORY 0.2 — well within numeric(5,4).
    expect(lines[0]!.taxRate).toBe(0.2);
    expect(lines[0]!.taxRate).toBeLessThan(9.9999);
    // Per-line tax is ONLY the item's share (10), NOT the smeared 610.
    expect(lines[0]!.taxAmount).toBe(10);
    expect(lines.reduce((s, l) => s + l.taxAmount, 0)).toBe(10); // sum(line tax) == items tax
    // Order tax = items tax + shipping tax.
    expect(totals.taxAmount).toBe(10 + 600);
    // Grand total = subtotal − discount + shipping + (items+shipping tax).
    expect(totals.totalAmount).toBe(50 - 0 + 3000 + 610);
  });

  it('multi-line goods + taxed shipping: line tax sums to items tax only, shipping stays order-level', () => {
    const inputs = [line({ unitPriceAmount: 1000, quantity: 2 }), line({ unitPriceAmount: 500 })];
    // items net 2500, 20% items tax = 500; shipping 1000, shipping tax 200.
    const { lines, totals } = buildSnapshot(inputs, 0, tax(500, 0.2, 200), 1000, false);
    expect(lines.reduce((s, l) => s + l.taxAmount, 0)).toBe(500); // items tax only
    expect(totals.taxAmount).toBe(700); // items + shipping
    expect(lines.every((l) => l.taxRate === 0.2)).toBe(true);
    expect(totals.totalAmount).toBe(2500 + 1000 + 700);
  });

  it('a zero-net (100%-discounted) line → rate 0, no divide-by-zero', () => {
    const inputs = [line({ unitPriceAmount: 1000, quantity: 1 })];
    // 100% discount → net 0, no items tax, no shipping.
    const { lines, totals } = buildSnapshot(inputs, 1000, tax(0, 0.2, 0), 0, false);
    expect(lines[0]!.taxRate).toBe(0);
    expect(lines[0]!.taxAmount).toBe(0);
    expect(Number.isFinite(lines[0]!.taxRate)).toBe(true);
    expect(totals.totalAmount).toBe(0);
  });
});
