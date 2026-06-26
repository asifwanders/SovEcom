/**
 * pure shipping cost engine. No I/O, no DB — unit-tested
 * in isolation. All money is integer minor units; cost is clamped ≥ 0.
 *
 * `computeRateCost(rate, ctx)`:
 *   - `flat`         → the rate amount.
 *   - `free_over`    → 0 when the order's goods value meets the threshold, else the amount.
 * The threshold base is the POST-discount items subtotal,
 *                      passed in as `ctx.itemsSubtotal` — the engine does not know about discounts.
 *   - `weight_based` → applies ONLY when the cart weight falls in the band
 *                      [weightMinGrams ?? 0, weightMaxGrams ?? ∞]; applicable → amount,
 *                      otherwise `null` (the band does not apply → caller drops this rate).
 *
 * Returns `null` to mean "this rate is not applicable to this cart" (only weight bands
 * produce this); a number is the integer cost.
 */

/** The minimal rate shape the engine needs (a subset of the `shipping_rates` row). */
export interface RateCostInput {
  type: 'flat' | 'free_over' | 'weight_based';
  amount: number;
  freeOverAmount: number | null;
  weightMinGrams: number | null;
  weightMaxGrams: number | null;
}

/** The cart-derived context for a cost computation. */
export interface ShippingContext {
  /** Post-discount goods subtotal (excl. shipping + tax), integer minor units. */
  itemsSubtotal: number;
  /** Total cart weight in grams: Σ(variant.weight_grams × qty); null weights count as 0. */
  totalWeightGrams: number;
}

/** Clamp to a non-negative integer minor-unit amount. */
function clampCost(amount: number): number {
  return Math.max(0, Math.trunc(amount));
}

export function computeRateCost(rate: RateCostInput, ctx: ShippingContext): number | null {
  switch (rate.type) {
    case 'flat':
      return clampCost(rate.amount);

    case 'free_over': {
      // A misconfigured free_over with no threshold behaves as a flat rate (never free).
      if (rate.freeOverAmount === null) return clampCost(rate.amount);
      return ctx.itemsSubtotal >= rate.freeOverAmount ? 0 : clampCost(rate.amount);
    }

    case 'weight_based': {
      const min = rate.weightMinGrams ?? 0;
      const max = rate.weightMaxGrams ?? Number.POSITIVE_INFINITY;
      if (ctx.totalWeightGrams < min || ctx.totalWeightGrams > max) return null; // band miss
      return clampCost(rate.amount);
    }

    default:
      // Exhaustive: an unknown type is not applicable rather than free.
      return null;
  }
}
