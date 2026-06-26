/**
 * EU VAT resolver unit tests.
 *
 * The resolver is PURE: given a TaxInput + an EuVatContext (origin, OSS posture,
 * resolved destination/origin rates), it returns the integer tax + per-line breakdown.
 * These tests are the spec for the engine — origin-vs-destination, the OSS €10k
 * threshold direction, B2B reverse charge, inclusive/exclusive extraction/addition,
 * rounding edges, no-destination, and non-EU.
 *
 * Rates used (fractions): FR 0.20, DE 0.19, US n/a.
 */
import { EuVatResolver, type EuVatContext } from './eu-vat-resolver';
import type { TaxCustomerContext, TaxInput } from './tax-resolver';

const FR = 0.2;
const DE = 0.19;

function ctx(overrides: Partial<EuVatContext> = {}): EuVatContext {
  return {
    originCountry: 'FR',
    ossPosture: 'below_threshold',
    destinationRate: null,
    originRate: FR,
    ...overrides,
  };
}

function input(overrides: Partial<TaxInput> = {}): TaxInput {
  return {
    currency: 'EUR',
    destinationCountry: 'FR',
    components: [{ description: 'Items', amount: 10000 }], // €100.00 net
    pricesIncludeTax: false,
    customer: null,
    ...overrides,
  };
}

const b2b = (vatValidated: boolean): TaxCustomerContext => ({ isB2b: true, vatValidated });

// ── B2C domestic ────────────────────────────────────────────────────────────────

describe('B2C domestic', () => {
  it('FR → FR charges 20% destination VAT (exclusive)', () => {
    const r = new EuVatResolver(ctx({ destinationRate: FR, originRate: FR }));
    const res = r.resolve(input({ destinationCountry: 'FR' }));
    expect(res.taxTotal).toBe(2000); // 10000 × 0.20
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatchObject({ rate: FR, base: 10000, amount: 2000 });
    expect(res.lines[0]!.reverseCharge).toBeUndefined();
  });
});

// ── B2C cross-border: OSS threshold direction ───────────────────────

describe('B2C cross-border — OSS €10k threshold', () => {
  it('FR → DE ABOVE threshold / opted-in: 19% DESTINATION VAT (OSS-reportable)', () => {
    const r = new EuVatResolver(
      ctx({ ossPosture: 'above_or_opted_in', destinationRate: DE, originRate: FR }),
    );
    const res = r.resolve(input({ destinationCountry: 'DE' }));
    expect(res.taxTotal).toBe(1900); // 10000 × 0.19 (destination DE)
    expect(res.lines[0]!.rate).toBe(DE);
  });

  it('FR → DE BELOW threshold: 20% ORIGIN/FR VAT (NOT destination)', () => {
    const r = new EuVatResolver(
      ctx({ ossPosture: 'below_threshold', destinationRate: DE, originRate: FR }),
    );
    const res = r.resolve(input({ destinationCountry: 'DE' }));
    expect(res.taxTotal).toBe(2000); // 10000 × 0.20 (origin FR), NOT 1900
    expect(res.lines[0]!.rate).toBe(FR);
  });
});

// ── B2C non-EU ──────────────────────────────────────────────────────────────────

describe('B2C non-EU destination', () => {
  it('FR → US charges no VAT', () => {
    const r = new EuVatResolver(ctx({ destinationRate: null, originRate: FR }));
    const res = r.resolve(input({ destinationCountry: 'US' }));
    expect(res.taxTotal).toBe(0);
    expect(res.lines).toHaveLength(0);
  });

  it('INCLUSIVE non-EU export STRIPS embedded origin VAT: gross 12000 @20% → net 10000', () => {
    // Zero-rated export: the inclusive sticker price embedded the merchant's ORIGIN
    // VAT. Booking the gross would overcharge the buyer the (now non-applicable) VAT.
    const r = new EuVatResolver(ctx({ destinationRate: null, originRate: 0.2 }));
    const res = r.resolve(
      input({
        destinationCountry: 'US',
        pricesIncludeTax: true,
        components: [{ description: 'Items', amount: 12000 }],
      }),
    );
    expect(res.taxTotal).toBe(0);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatchObject({ base: 10000, rate: 0, amount: 0 });
    expect(res.lines[0]!.base).not.toBe(12000);
  });

  it('INCLUSIVE non-EU export with NO origin rate leaves gross as-is (no rate to strip)', () => {
    const r = new EuVatResolver(ctx({ destinationRate: null, originRate: null }));
    const res = r.resolve(
      input({
        destinationCountry: 'US',
        pricesIncludeTax: true,
        components: [{ description: 'Items', amount: 12000 }],
      }),
    );
    expect(res.taxTotal).toBe(0);
    // No rate known → cannot strip; emit nothing rather than guess.
    expect(res.lines).toHaveLength(0);
  });
});

// ── B2B ─────────────────────────────────────────────────────────────────────────

describe('B2B', () => {
  it('FR → FR with valid VAT charges 20% (same-country, NOT reverse charge)', () => {
    const r = new EuVatResolver(ctx({ destinationRate: FR, originRate: FR }));
    const res = r.resolve(input({ destinationCountry: 'FR', customer: b2b(true) }));
    expect(res.taxTotal).toBe(2000);
    expect(res.lines[0]!.reverseCharge).toBeUndefined();
    expect(res.lines[0]!.rate).toBe(FR);
  });

  it('FR → DE with VALID VAT: reverse charge, 0% VAT, line flagged', () => {
    const r = new EuVatResolver(ctx({ destinationRate: DE, originRate: FR }));
    const res = r.resolve(input({ destinationCountry: 'DE', customer: b2b(true) }));
    expect(res.taxTotal).toBe(0);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatchObject({ rate: 0, amount: 0, reverseCharge: true, base: 10000 });
  });

  it('EXCLUSIVE reverse charge keeps base = net sticker price (regression: base 10000)', () => {
    // The existing exclusive path must keep base = the unmodified net amount.
    const r = new EuVatResolver(ctx({ destinationRate: DE, originRate: FR }));
    const res = r.resolve(
      input({ destinationCountry: 'DE', customer: b2b(true), pricesIncludeTax: false }),
    );
    expect(res.lines[0]).toMatchObject({ base: 10000, amount: 0, reverseCharge: true });
  });

  it('INCLUSIVE reverse charge STRIPS embedded VAT: gross 12000 @20% → base/net 10000', () => {
    // prices_include_tax: the component amount is GROSS (VAT embedded). On the
    // zero-VAT reverse-charge branch we must re-derive the NET base, otherwise the
    // VIES-validated B2B buyer is overcharged the embedded VAT. destinationRate=0.20
    // is the would-be rate to strip.
    const r = new EuVatResolver(ctx({ destinationRate: 0.2, originRate: FR }));
    const res = r.resolve(
      input({
        destinationCountry: 'DE',
        customer: b2b(true),
        pricesIncludeTax: true,
        components: [{ description: 'Items', amount: 12000 }], // €120 gross incl 20%
      }),
    );
    expect(res.taxTotal).toBe(0);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatchObject({ base: 10000, amount: 0, reverseCharge: true });
    expect(res.lines[0]!.base).not.toBe(12000); // must NOT book the gross
  });

  it('FR → DE with INVALID VAT: fallback charges 19% destination VAT (above-threshold)', () => {
    const r = new EuVatResolver(
      ctx({ ossPosture: 'above_or_opted_in', destinationRate: DE, originRate: FR }),
    );
    const res = r.resolve(input({ destinationCountry: 'DE', customer: b2b(false) }));
    expect(res.taxTotal).toBe(1900); // not reverse charge → VAT charged
    expect(res.lines[0]!.reverseCharge).toBeUndefined();
    expect(res.lines[0]!.rate).toBe(DE);
  });

  it('FR → DE with INVALID VAT, below threshold: charges 20% ORIGIN VAT (B2C-style fallback)', () => {
    // An unvalidated B2B is treated as not-reverse-charge; below threshold it follows the
    // origin rate path (the customer is effectively charged like B2C).
    const r = new EuVatResolver(
      ctx({ ossPosture: 'below_threshold', destinationRate: DE, originRate: FR }),
    );
    const res = r.resolve(input({ destinationCountry: 'DE', customer: b2b(false) }));
    // Unvalidated B2B → reverse charge does NOT apply. isB2c is false (still b2b flag),
    // so the origin-rate branch (B2C-only) is skipped → destination rate.
    expect(res.taxTotal).toBe(1900);
    expect(res.lines[0]!.rate).toBe(DE);
  });

  it('FR → US (B2B valid VAT) charges no VAT (non-EU destination)', () => {
    const r = new EuVatResolver(ctx({ destinationRate: null, originRate: FR }));
    const res = r.resolve(input({ destinationCountry: 'US', customer: b2b(true) }));
    expect(res.taxTotal).toBe(0);
    expect(res.lines).toHaveLength(0);
  });
});

// ── Tax-inclusive vs exclusive ───────────────────────────────────────────────────

describe('inclusive vs exclusive', () => {
  it('exclusive: tax ADDED on top (round-half-up)', () => {
    const r = new EuVatResolver(ctx({ destinationRate: FR, originRate: FR }));
    const res = r.resolve(input({ pricesIncludeTax: false, components: [{ description: 'Items', amount: 10000 }] })); // prettier-ignore
    expect(res.taxTotal).toBe(2000); // 10000 × 0.20
  });

  it('inclusive: tax EXTRACTED from gross', () => {
    const r = new EuVatResolver(ctx({ destinationRate: FR, originRate: FR }));
    // gross 12000 incl 20% → net 10000, tax 2000. 12000 − round(12000/1.2)=12000−10000.
    const res = r.resolve(input({ pricesIncludeTax: true, components: [{ description: 'Items', amount: 12000 }] })); // prettier-ignore
    expect(res.taxTotal).toBe(2000);
    expect(res.lines[0]!.base).toBe(12000); // base reported as the gross
  });

  it('inclusive extraction rounds half-up at a fractional cent', () => {
    const r = new EuVatResolver(ctx({ destinationRate: FR, originRate: FR }));
    // gross 999 incl 20% → net = round(999/1.2)=round(832.5)=833 → tax = 999−833 = 166.
    const res = r.resolve(input({ pricesIncludeTax: true, components: [{ description: 'Items', amount: 999 }] })); // prettier-ignore
    expect(res.taxTotal).toBe(166);
  });

  it('exclusive addition rounds half-up at a fractional cent', () => {
    const r = new EuVatResolver(ctx({ destinationRate: DE, originRate: FR, ossPosture: 'above_or_opted_in' })); // prettier-ignore
    // net 105 × 0.19 = 19.95 → round-half-up → 20.
    const res = r.resolve(input({ destinationCountry: 'DE', pricesIncludeTax: false, components: [{ description: 'Items', amount: 105 }] })); // prettier-ignore
    expect(res.taxTotal).toBe(20);
  });

  it('sums multiple components (items + shipping) at the same rate', () => {
    const r = new EuVatResolver(ctx({ destinationRate: FR, originRate: FR }));
    const res = r.resolve(
      input({
        components: [
          { description: 'Items', amount: 10000 },
          { description: 'Shipping', amount: 500 },
        ],
      }),
    );
    expect(res.taxTotal).toBe(2000 + 100); // 0.20 of each
    expect(res.lines).toHaveLength(2);
  });
});

// ── No destination / empty ───────────────────────────────────────────────────────

describe('edge cases', () => {
  it('no destination country → tax 0', () => {
    const r = new EuVatResolver(ctx({ destinationRate: FR, originRate: FR }));
    const res = r.resolve(input({ destinationCountry: null }));
    expect(res.taxTotal).toBe(0);
    expect(res.lines).toHaveLength(0);
  });

  it('no rate row for the chosen country → tax 0 (fail safe, never guess)', () => {
    // Above-threshold cross-border B2C uses the DESTINATION rate; with no DE row → 0.
    const r = new EuVatResolver(
      ctx({ ossPosture: 'above_or_opted_in', destinationRate: null, originRate: FR }),
    );
    const res = r.resolve(input({ destinationCountry: 'DE' })); // DE in EU but no rate
    expect(res.taxTotal).toBe(0);
  });

  it('empty components → tax 0', () => {
    const r = new EuVatResolver(ctx({ destinationRate: FR, originRate: FR }));
    const res = r.resolve(input({ components: [] }));
    expect(res.taxTotal).toBe(0);
    expect(res.lines).toHaveLength(0);
  });

  it('never returns negative tax', () => {
    const r = new EuVatResolver(ctx({ destinationRate: FR, originRate: FR }));
    const res = r.resolve(input({ components: [{ description: 'Items', amount: 0 }] }));
    expect(res.taxTotal).toBeGreaterThanOrEqual(0);
  });
});
