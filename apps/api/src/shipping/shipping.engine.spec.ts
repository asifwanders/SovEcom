import { computeRateCost, type RateCostInput, type ShippingContext } from './shipping.engine';

const ctx = (over: Partial<ShippingContext> = {}): ShippingContext => ({
  itemsSubtotal: 0,
  totalWeightGrams: 0,
  ...over,
});

const rate = (over: Partial<RateCostInput>): RateCostInput => ({
  type: 'flat',
  amount: 0,
  freeOverAmount: null,
  weightMinGrams: null,
  weightMaxGrams: null,
  ...over,
});

describe('computeRateCost', () => {
  describe('flat', () => {
    it('returns the amount regardless of cart context', () => {
      expect(
        computeRateCost(rate({ type: 'flat', amount: 490 }), ctx({ itemsSubtotal: 10000 })),
      ).toBe(490);
    });
    it('clamps a negative amount to 0', () => {
      expect(computeRateCost(rate({ type: 'flat', amount: -5 }), ctx())).toBe(0);
    });
  });

  describe('free_over', () => {
    it('charges the amount BELOW the threshold', () => {
      const r = rate({ type: 'free_over', amount: 590, freeOverAmount: 5000 });
      expect(computeRateCost(r, ctx({ itemsSubtotal: 4999 }))).toBe(590);
    });
    it('is FREE at exactly the threshold (>=)', () => {
      const r = rate({ type: 'free_over', amount: 590, freeOverAmount: 5000 });
      expect(computeRateCost(r, ctx({ itemsSubtotal: 5000 }))).toBe(0);
    });
    it('is FREE above the threshold', () => {
      const r = rate({ type: 'free_over', amount: 590, freeOverAmount: 5000 });
      expect(computeRateCost(r, ctx({ itemsSubtotal: 9999 }))).toBe(0);
    });
    it('uses the POST-discount subtotal it is handed (a discounted cart can drop below)', () => {
      const r = rate({ type: 'free_over', amount: 590, freeOverAmount: 5000 });
      // Goods were 6000 but a discount brought the base to 4500 → no free shipping.
      expect(computeRateCost(r, ctx({ itemsSubtotal: 4500 }))).toBe(590);
    });
    it('falls back to flat (never free) when no threshold is configured', () => {
      const r = rate({ type: 'free_over', amount: 590, freeOverAmount: null });
      expect(computeRateCost(r, ctx({ itemsSubtotal: 100000 }))).toBe(590);
    });
  });

  describe('weight_based', () => {
    const band = (min: number | null, max: number | null, amount = 700) =>
      rate({ type: 'weight_based', amount, weightMinGrams: min, weightMaxGrams: max });

    it('applies inside the band', () => {
      expect(computeRateCost(band(0, 1000), ctx({ totalWeightGrams: 500 }))).toBe(700);
    });
    it('applies at the band boundaries (inclusive min and max)', () => {
      expect(computeRateCost(band(500, 1000), ctx({ totalWeightGrams: 500 }))).toBe(700);
      expect(computeRateCost(band(500, 1000), ctx({ totalWeightGrams: 1000 }))).toBe(700);
    });
    it('returns null (band miss) below min', () => {
      expect(computeRateCost(band(500, 1000), ctx({ totalWeightGrams: 499 }))).toBeNull();
    });
    it('returns null (band miss) above max', () => {
      expect(computeRateCost(band(500, 1000), ctx({ totalWeightGrams: 1001 }))).toBeNull();
    });
    it('treats null min as 0 and null max as ∞ (open-ended bands)', () => {
      expect(computeRateCost(band(null, 1000), ctx({ totalWeightGrams: 0 }))).toBe(700);
      expect(computeRateCost(band(2000, null), ctx({ totalWeightGrams: 999999 }))).toBe(700);
      expect(computeRateCost(band(2000, null), ctx({ totalWeightGrams: 1999 }))).toBeNull();
    });
  });
});
