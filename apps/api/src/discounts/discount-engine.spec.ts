/**
 * DiscountEngine unit spec. 50+ scenarios, INTEGER assertions only.
 *
 * Discount bugs lose stores real money, so every branch of the algorithm is pinned:
 * percentage/fixed compute, min-cart, scope (products/categories), segments, stacking,
 * date ranges, usage limits, currency match, rounding edges, clamping, empty cart.
 */
import {
  DiscountEngine,
  type CandidateDiscount,
  type DiscountCartSnapshot,
  type DiscountLineItem,
  type DiscountEvalContext,
  type DiscountScope,
  percentAmount,
} from './discount-engine';
import * as discountEngineModule from './discount-engine';

const engine = new DiscountEngine();

// ── builders ───────────────────────────────────────────────────────────────────

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `disc-${String(idSeq).padStart(4, '0')}`;
}

function item(overrides: Partial<DiscountLineItem> & { productId: string }): DiscountLineItem {
  return { unitPriceAmount: 1000, quantity: 1, ...overrides };
}

function cart(
  items: DiscountLineItem[],
  opts: { currency?: string; productCategories?: Map<string, Set<string>> } = {},
): DiscountCartSnapshot {
  const subtotal = items.reduce((s, i) => s + i.unitPriceAmount * i.quantity, 0);
  return {
    currency: opts.currency ?? 'EUR',
    subtotal,
    items,
    productCategories: opts.productCategories ?? new Map(),
  };
}

function discount(overrides: Partial<CandidateDiscount> = {}): CandidateDiscount {
  return {
    id: overrides.id ?? nextId(),
    code: null,
    type: 'percentage',
    value: 1000, // 10%
    currency: null,
    minCartAmount: null,
    appliesTo: 'all',
    targetIds: null,
    customerSegment: 'all',
    stackable: false,
    usageLimitTotal: null,
    usageLimitPerCustomer: null,
    usedCount: 0,
    startsAt: null,
    endsAt: null,
    active: true,
    ...overrides,
  };
}

function ctx(overrides: Partial<DiscountEvalContext> = {}): DiscountEvalContext {
  return {
    isB2b: false,
    perCustomerUsage: new Map(),
    now: new Date('2026-06-11T12:00:00Z'),
    ...overrides,
  };
}

function evalOne(
  c: CandidateDiscount,
  snapshot: DiscountCartSnapshot,
  context: DiscountEvalContext = ctx(),
): { amount: number; total: number; appliedCount: number } {
  const r = engine.evaluate({ cart: snapshot, candidates: [c], context });
  return {
    amount: r.applied[0]?.amount ?? 0,
    total: r.discountTotal,
    appliedCount: r.applied.filter((a) => a.amount > 0).length,
  };
}

const PA = 'prodA';
const PB = 'prodB';
const CAT1 = 'cat1';
const CAT2 = 'cat2';

// ── 1–4. Percentage on subtotal ──────────────────────────────────────────────

describe('percentage on subtotal', () => {
  it('10% of 1000 = 100', () => {
    expect(evalOne(discount({ value: 1000 }), cart([item({ productId: PA })])).amount).toBe(100);
  });
  it('25% of 4000 = 1000', () => {
    expect(
      evalOne(discount({ value: 2500 }), cart([item({ productId: PA, unitPriceAmount: 4000 })]))
        .amount,
    ).toBe(1000);
  });
  it('100% of 2599 = 2599 (full subtotal)', () => {
    expect(
      evalOne(discount({ value: 10000 }), cart([item({ productId: PA, unitPriceAmount: 2599 })]))
        .amount,
    ).toBe(2599);
  });
  it('0% of 1000 = 0 (not applied)', () => {
    const r = evalOne(discount({ value: 0 }), cart([item({ productId: PA })]));
    expect(r.amount).toBe(0);
    expect(r.appliedCount).toBe(0);
  });
});

// ── 5–7. Fixed on subtotal ───────────────────────────────────────────────────

describe('fixed on subtotal', () => {
  it('fixed 500 off 1000 = 500', () => {
    expect(
      evalOne(discount({ type: 'fixed', value: 500 }), cart([item({ productId: PA })])).amount,
    ).toBe(500);
  });
  it('fixed 500 off 500 = 500 (exact)', () => {
    expect(
      evalOne(
        discount({ type: 'fixed', value: 500 }),
        cart([item({ productId: PA, unitPriceAmount: 500 })]),
      ).amount,
    ).toBe(500);
  });
  it('fixed 2000 off 1000 clamps to 1000 (min(value, base))', () => {
    expect(
      evalOne(discount({ type: 'fixed', value: 2000 }), cart([item({ productId: PA })])).amount,
    ).toBe(1000);
  });
});

// ── 8–10. min_cart enforcement (below / at / above) ──────────────────────────

describe('min_cart enforcement', () => {
  const d = discount({ value: 1000, minCartAmount: 2000 });
  it('below min → not applied', () => {
    expect(evalOne(d, cart([item({ productId: PA, unitPriceAmount: 1999 })])).appliedCount).toBe(0);
  });
  it('at min → applied', () => {
    const r = evalOne(d, cart([item({ productId: PA, unitPriceAmount: 2000 })]));
    expect(r.amount).toBe(200);
  });
  it('above min → applied', () => {
    const r = evalOne(d, cart([item({ productId: PA, unitPriceAmount: 5000 })]));
    expect(r.amount).toBe(500);
  });
});

// ── 11–14. products scope (matching / non-matching / mixed) ──────────────────

describe('products scope', () => {
  const d = discount({ value: 5000, appliesTo: 'products', targetIds: [PA] }); // 50% of matching
  it('matching product → base = that line', () => {
    expect(evalOne(d, cart([item({ productId: PA, unitPriceAmount: 1000 })])).amount).toBe(500);
  });
  it('non-matching product → not applied (no intersection)', () => {
    expect(evalOne(d, cart([item({ productId: PB, unitPriceAmount: 1000 })])).appliedCount).toBe(0);
  });
  it('mixed cart → base only the matching line', () => {
    const r = evalOne(
      d,
      cart([
        item({ productId: PA, unitPriceAmount: 1000, quantity: 2 }), // 2000 matching
        item({ productId: PB, unitPriceAmount: 3000 }), // ignored
      ]),
    );
    expect(r.amount).toBe(1000); // 50% of 2000
  });
  it('products scope with empty targetIds → not applied', () => {
    const r = evalOne(
      discount({ value: 5000, appliesTo: 'products', targetIds: [] }),
      cart([item({ productId: PA })]),
    );
    expect(r.appliedCount).toBe(0);
  });
});

// ── 15–17. categories scope ──────────────────────────────────────────────────

describe('categories scope', () => {
  const pcats = new Map<string, Set<string>>([
    [PA, new Set([CAT1])],
    [PB, new Set([CAT2])],
  ]);
  const d = discount({ value: 2000, appliesTo: 'categories', targetIds: [CAT1] }); // 20%
  it('product in target category → base = that line', () => {
    expect(
      evalOne(
        d,
        cart([item({ productId: PA, unitPriceAmount: 5000 })], { productCategories: pcats }),
      ).amount,
    ).toBe(1000);
  });
  it('product not in target category → not applied', () => {
    expect(
      evalOne(
        d,
        cart([item({ productId: PB, unitPriceAmount: 5000 })], { productCategories: pcats }),
      ).appliedCount,
    ).toBe(0);
  });
  it('mixed categories → base only the in-category lines', () => {
    const r = evalOne(
      d,
      cart([item({ productId: PA, unitPriceAmount: 5000 }), item({ productId: PB, unitPriceAmount: 5000 })], { productCategories: pcats }), // prettier-ignore
    );
    expect(r.amount).toBe(1000); // 20% of 5000 (only PA in cat1)
  });
});

// ── 18–20. b2b / all segment ─────────────────────────────────────────────────

describe('customer segments', () => {
  it('b2b discount + b2b customer → applies', () => {
    const r = evalOne(
      discount({ value: 1000, customerSegment: 'b2b' }),
      cart([item({ productId: PA })]),
      ctx({ isB2b: true }),
    );
    expect(r.amount).toBe(100);
  });
  it('b2b discount + non-b2b customer → not applied', () => {
    const r = evalOne(
      discount({ value: 1000, customerSegment: 'b2b' }),
      cart([item({ productId: PA })]),
      ctx({ isB2b: false }),
    );
    expect(r.appliedCount).toBe(0);
  });
  it('all segment applies to anyone', () => {
    expect(
      evalOne(discount({ value: 1000, customerSegment: 'all' }), cart([item({ productId: PA })]))
        .amount,
    ).toBe(100);
  });
  it('null segment treated as all', () => {
    expect(
      evalOne(discount({ value: 1000, customerSegment: null }), cart([item({ productId: PA })]))
        .amount,
    ).toBe(100);
  });
});

// ── 21–26. first_time / returning segments ──

describe('first_time / returning segments', () => {
  const FIRST = discount({ value: 1000, customerSegment: 'first_time' });
  const RETURNING = discount({ value: 1000, customerSegment: 'returning' });
  const c = cart([item({ productId: PA })]);

  it('first_time applies to a customer with NO prior order', () => {
    expect(evalOne(FIRST, c, ctx({ customerHasPriorOrder: false })).amount).toBe(100);
  });
  it('first_time does NOT apply to a customer with a prior order', () => {
    expect(evalOne(FIRST, c, ctx({ customerHasPriorOrder: true })).appliedCount).toBe(0);
  });
  it('returning applies to a customer with ≥1 prior order', () => {
    expect(evalOne(RETURNING, c, ctx({ customerHasPriorOrder: true })).amount).toBe(100);
  });
  it('returning does NOT apply to a customer with no prior order', () => {
    expect(evalOne(RETURNING, c, ctx({ customerHasPriorOrder: false })).appliedCount).toBe(0);
  });
  it('a GUEST (no order-history signal) is NEITHER first_time NOR returning', () => {
    // customerHasPriorOrder undefined/null → both segmented discounts are excluded.
    expect(evalOne(FIRST, c, ctx({ customerHasPriorOrder: null })).appliedCount).toBe(0);
    expect(evalOne(RETURNING, c, ctx({ customerHasPriorOrder: null })).appliedCount).toBe(0);
    expect(evalOne(FIRST, c, ctx()).appliedCount).toBe(0); // undefined too
    expect(evalOne(RETURNING, c, ctx()).appliedCount).toBe(0);
  });
  it('unknown segment → not applied (fail closed)', () => {
    expect(
      evalOne(discount({ value: 1000, customerSegment: 'vip-mystery' }), c, ctx()).appliedCount,
    ).toBe(0);
  });
});

// ── 24–27. stacking ──────────────────────────────────────────────────────────

describe('stacking', () => {
  const c = cart([item({ productId: PA, unitPriceAmount: 10000 })]); // subtotal 10000

  it('stackable + stackable → both apply (largest first)', () => {
    const a = discount({ id: 'A', value: 1000, stackable: true }); // 1000
    const b = discount({ id: 'B', value: 2000, stackable: true }); // 2000
    const r = engine.evaluate({ cart: c, candidates: [a, b], context: ctx() });
    expect(r.applied.map((x) => x.amount)).toEqual([2000, 1000]);
    expect(r.discountTotal).toBe(3000);
  });

  it('non-stackable + non-stackable → single best applied', () => {
    const a = discount({ id: 'A', value: 1000, stackable: false }); // 1000
    const b = discount({ id: 'B', value: 3000, stackable: false }); // 3000
    const r = engine.evaluate({ cart: c, candidates: [a, b], context: ctx() });
    expect(r.applied.filter((x) => x.amount > 0)).toHaveLength(1);
    expect(r.discountTotal).toBe(3000);
    expect(r.applied[0]!.discountId).toBe('B');
  });

  it('non-stackable + stackable → both apply', () => {
    const ns = discount({ id: 'NS', value: 1000, stackable: false }); // 1000
    const s = discount({ id: 'S', value: 2000, stackable: true }); // 2000
    const r = engine.evaluate({ cart: c, candidates: [ns, s], context: ctx() });
    expect(r.discountTotal).toBe(3000);
    expect(r.applied.filter((x) => x.amount > 0)).toHaveLength(2);
  });

  it('two non-stackable + one stackable → best non-stackable + the stackable', () => {
    const ns1 = discount({ id: 'NS1', value: 1000, stackable: false }); // 1000
    const ns2 = discount({ id: 'NS2', value: 4000, stackable: false }); // 4000 (best)
    const s = discount({ id: 'S', value: 1000, stackable: true }); // 1000
    const r = engine.evaluate({ cart: c, candidates: [ns1, ns2, s], context: ctx() });
    expect(r.discountTotal).toBe(5000); // 4000 + 1000
    const ids = r.applied.filter((x) => x.amount > 0).map((x) => x.discountId);
    expect(ids).toContain('NS2');
    expect(ids).toContain('S');
    expect(ids).not.toContain('NS1');
  });

  it('non-stackable tie → deterministic pick by discountId', () => {
    const a = discount({ id: 'aaa', value: 2000, stackable: false });
    const b = discount({ id: 'bbb', value: 2000, stackable: false });
    const r1 = engine.evaluate({ cart: c, candidates: [a, b], context: ctx() });
    const r2 = engine.evaluate({ cart: c, candidates: [b, a], context: ctx() });
    expect(r1.applied[0]!.discountId).toBe('aaa');
    expect(r2.applied[0]!.discountId).toBe('aaa');
  });
});

// ── 28–32. date range ────────────────────────────────────────────────────────

describe('date range', () => {
  const c = cart([item({ productId: PA })]);
  const now = new Date('2026-06-11T12:00:00Z');
  it('before starts_at → not applied', () => {
    const d = discount({ value: 1000, startsAt: new Date('2026-06-12T00:00:00Z') });
    expect(evalOne(d, c, ctx({ now })).appliedCount).toBe(0);
  });
  it('after ends_at → not applied', () => {
    const d = discount({ value: 1000, endsAt: new Date('2026-06-10T00:00:00Z') });
    expect(evalOne(d, c, ctx({ now })).appliedCount).toBe(0);
  });
  it('within window → applied', () => {
    const d = discount({
      value: 1000,
      startsAt: new Date('2026-06-01T00:00:00Z'),
      endsAt: new Date('2026-06-30T00:00:00Z'),
    });
    expect(evalOne(d, c, ctx({ now })).amount).toBe(100);
  });
  it('null bounds → always in range', () => {
    const d = discount({ value: 1000, startsAt: null, endsAt: null });
    expect(evalOne(d, c, ctx({ now })).amount).toBe(100);
  });
  it('exactly at starts_at boundary → applied (inclusive)', () => {
    const d = discount({ value: 1000, startsAt: now });
    expect(evalOne(d, c, ctx({ now })).amount).toBe(100);
  });
  it('exactly at ends_at boundary → applied (inclusive)', () => {
    const d = discount({ value: 1000, endsAt: now });
    expect(evalOne(d, c, ctx({ now })).amount).toBe(100);
  });
});

// ── 33–37. usage-limit eligibility ───────────────────────────────────────────

describe('usage limits (read-only eligibility)', () => {
  const c = cart([item({ productId: PA })]);
  it('total exhausted (used_count >= limit) → not applied', () => {
    const d = discount({ value: 1000, usageLimitTotal: 5, usedCount: 5 });
    expect(evalOne(d, c).appliedCount).toBe(0);
  });
  it('total under limit → applied', () => {
    const d = discount({ value: 1000, usageLimitTotal: 5, usedCount: 4 });
    expect(evalOne(d, c).amount).toBe(100);
  });
  it('per-customer exhausted → not applied', () => {
    const d = discount({ id: 'PCU', value: 1000, usageLimitPerCustomer: 1 });
    const context = ctx({ perCustomerUsage: new Map([['PCU', 1]]) });
    expect(evalOne(d, c, context).appliedCount).toBe(0);
  });
  it('per-customer under limit → applied', () => {
    const d = discount({ id: 'PCU2', value: 1000, usageLimitPerCustomer: 2 });
    const context = ctx({ perCustomerUsage: new Map([['PCU2', 1]]) });
    expect(evalOne(d, c, context).amount).toBe(100);
  });
  it('no usage info for this customer → treated as 0 used', () => {
    const d = discount({ id: 'PCU3', value: 1000, usageLimitPerCustomer: 1 });
    expect(evalOne(d, c, ctx()).amount).toBe(100);
  });
});

// ── 38–40. currency mismatch (fixed) ─────────────────────────────────────────

describe('currency match (fixed only)', () => {
  it('fixed with matching currency → applied', () => {
    const d = discount({ type: 'fixed', value: 500, currency: 'EUR' });
    expect(evalOne(d, cart([item({ productId: PA })], { currency: 'EUR' })).amount).toBe(500);
  });
  it('fixed with mismatched currency → not applied', () => {
    const d = discount({ type: 'fixed', value: 500, currency: 'USD' });
    expect(evalOne(d, cart([item({ productId: PA })], { currency: 'EUR' })).appliedCount).toBe(0);
  });
  it('fixed with null currency → applies regardless of cart currency', () => {
    const d = discount({ type: 'fixed', value: 500, currency: null });
    expect(evalOne(d, cart([item({ productId: PA })], { currency: 'EUR' })).amount).toBe(500);
  });
  it('percentage ignores currency entirely', () => {
    const d = discount({ type: 'percentage', value: 1000, currency: 'USD' });
    expect(evalOne(d, cart([item({ productId: PA })], { currency: 'EUR' })).amount).toBe(100);
  });
});

// ── 41–46. rounding edge cases (round half up, documented) ───────────────────

describe('rounding (round half up to the minor unit)', () => {
  it('33% of 1000 = 330 (exact, no rounding)', () => {
    expect(percentAmount(1000, 3300)).toBe(330);
    expect(
      evalOne(discount({ value: 3300 }), cart([item({ productId: PA, unitPriceAmount: 1000 })]))
        .amount,
    ).toBe(330);
  });
  it('33% of 1001 = 330 (330.33 → down)', () => {
    expect(percentAmount(1001, 3300)).toBe(330);
  });
  it('50% of 1001 = 501 (500.5 → half up)', () => {
    expect(percentAmount(1001, 5000)).toBe(501);
    expect(
      evalOne(discount({ value: 5000 }), cart([item({ productId: PA, unitPriceAmount: 1001 })]))
        .amount,
    ).toBe(501);
  });
  it('15% of 333 = 50 (49.95 → up)', () => {
    expect(percentAmount(333, 1500)).toBe(50);
  });
  it('1% of 149 = 1 (1.49 → down)', () => {
    expect(percentAmount(149, 100)).toBe(1);
  });
  it('1% of 150 = 2 (1.5 → half up)', () => {
    expect(percentAmount(150, 100)).toBe(2);
  });
  it('fractional percent (12.5% = value 1250) of 200 = 25 (exact)', () => {
    expect(percentAmount(200, 1250)).toBe(25);
  });
});

// ── 47–50. clamping & non-negative grand total ───────────────────────────────

describe('clamping & non-negative total', () => {
  it('fixed discount ≥ base clamps to base', () => {
    const r = evalOne(
      discount({ type: 'fixed', value: 99999 }),
      cart([item({ productId: PA, unitPriceAmount: 1000 })]),
    );
    expect(r.amount).toBe(1000);
  });
  it('two stackable fixed discounts cannot exceed subtotal (total clamped)', () => {
    const c = cart([item({ productId: PA, unitPriceAmount: 1000 })]); // subtotal 1000
    const a = discount({ id: 'A', type: 'fixed', value: 700, stackable: true });
    const b = discount({ id: 'B', type: 'fixed', value: 700, stackable: true });
    const r = engine.evaluate({ cart: c, candidates: [a, b], context: ctx() });
    expect(r.discountTotal).toBe(1000); // 700 + 300 (clamped), never 1400
    expect(r.discountTotal).toBeLessThanOrEqual(c.subtotal);
  });
  it('grandTotal (subtotal - discountTotal) is never negative', () => {
    const c = cart([item({ productId: PA, unitPriceAmount: 1000 })]);
    const a = discount({ id: 'A', type: 'fixed', value: 1000, stackable: true });
    const b = discount({ id: 'B', type: 'fixed', value: 1000, stackable: true });
    const r = engine.evaluate({ cart: c, candidates: [a, b], context: ctx() });
    expect(c.subtotal - r.discountTotal).toBe(0);
    expect(c.subtotal - r.discountTotal).toBeGreaterThanOrEqual(0);
  });
  it('100% percentage exactly zeroes the subtotal, no overshoot', () => {
    const c = cart([item({ productId: PA, unitPriceAmount: 4567 })]);
    const r = engine.evaluate({
      cart: c,
      candidates: [discount({ value: 10000 })],
      context: ctx(),
    });
    expect(r.discountTotal).toBe(4567);
  });
});

// ── 51–54. empty cart & no-candidate edges ───────────────────────────────────

describe('empty cart & edges', () => {
  const empty = cart([]);
  it('empty cart, all-scope discount → nothing applied (zero base)', () => {
    expect(evalOne(discount({ value: 1000, appliesTo: 'all' }), empty).appliedCount).toBe(0);
  });
  it('empty cart, products-scope discount → nothing applied', () => {
    expect(
      evalOne(discount({ value: 1000, appliesTo: 'products', targetIds: [PA] }), empty)
        .appliedCount,
    ).toBe(0);
  });
  it('no candidates → empty result, zero total', () => {
    const r = engine.evaluate({
      cart: cart([item({ productId: PA })]),
      candidates: [],
      context: ctx(),
    });
    expect(r.applied).toHaveLength(0);
    expect(r.discountTotal).toBe(0);
  });
  it('inactive discount → not applied', () => {
    expect(
      evalOne(discount({ value: 1000, active: false }), cart([item({ productId: PA })]))
        .appliedCount,
    ).toBe(0);
  });
});

// ── Z4 dead-code guard ────────────────────────────────────────────────────────

describe('Z4 dead-code: EVALUABLE_SEGMENTS must NOT be exported', () => {
  it('discount-engine does not export EVALUABLE_SEGMENTS', () => {
    expect((discountEngineModule as Record<string, unknown>)['EVALUABLE_SEGMENTS']).toBeUndefined();
  });
});

// ── 55–57. determinism & scope reporting ─────────────────────────────────────

describe('determinism & output shape', () => {
  it('repeated evaluation yields identical output', () => {
    const c = cart([item({ productId: PA, unitPriceAmount: 10000 })]);
    const cands = [
      discount({ id: 'A', value: 1000, stackable: true }),
      discount({ id: 'B', value: 3000, stackable: true }),
    ];
    const r1 = engine.evaluate({ cart: c, candidates: cands, context: ctx() });
    const r2 = engine.evaluate({ cart: c, candidates: cands, context: ctx() });
    expect(r1).toEqual(r2);
  });
  it('applied entry reports the discount scope', () => {
    const r = engine.evaluate({
      cart: cart([item({ productId: PA, unitPriceAmount: 1000 })]),
      candidates: [discount({ value: 1000, appliesTo: 'all' })],
      context: ctx(),
    });
    const scope: DiscountScope = r.applied[0]!.scope;
    expect(scope).toBe('all');
  });
  it('applied entry carries the code (for store apply feedback)', () => {
    const r = engine.evaluate({
      cart: cart([item({ productId: PA, unitPriceAmount: 1000 })]),
      candidates: [discount({ value: 1000, code: 'SAVE10' })],
      context: ctx(),
    });
    expect(r.applied[0]!.code).toBe('SAVE10');
  });
});
