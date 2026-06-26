/**
 * Discount eligibility helpers. PURE, integer math.
 *
 * Each helper answers one eligibility question. They are deliberately tiny and
 * side-effect free so the engine spec can assert each rule in isolation.
 */
import type { CandidateDiscount, DiscountCartSnapshot } from './discount-engine';

/** Clamp `n` into the inclusive integer range [lo, hi]. */
export function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * `now` is within [startsAt, endsAt]. Null bounds are open (no lower / no upper).
 * Bounds are INCLUSIVE on the start, INCLUSIVE on the end instant.
 */
export function withinDateRange(startsAt: Date | null, endsAt: Date | null, now: Date): boolean {
  if (startsAt != null && now.getTime() < startsAt.getTime()) return false;
  if (endsAt != null && now.getTime() > endsAt.getTime()) return false;
  return true;
}

/** Subtotal meets the minimum-cart threshold (null = no minimum). At-threshold passes. */
export function meetsMinCart(minCartAmount: number | null, subtotal: number): boolean {
  if (minCartAmount == null) return true;
  return subtotal >= minCartAmount;
}

/**
 * Customer-segment match. `all` always matches; `b2b`
 * matches a B2B customer. `first_time`/`returning` are now wired to the cart owner's
 * order history (the engine receives `customerHasPriorOrder`):
 *  - `first_time` matches ⇔ the customer has NO prior order (`customerHasPriorOrder === false`);
 *  - `returning`  matches ⇔ the customer has ≥1 prior order (`customerHasPriorOrder === true`).
 * A GUEST cart (no customer → `customerHasPriorOrder` null/undefined) matches NEITHER —
 * those segmented discounts do not apply to guests. Any unknown segment fails closed.
 */
export function segmentMatches(
  segment: string | null,
  isB2b: boolean,
  customerHasPriorOrder?: boolean | null,
): boolean {
  if (segment == null || segment === 'all') return true;
  if (segment === 'b2b') return isB2b;
  if (segment === 'first_time') return customerHasPriorOrder === false;
  if (segment === 'returning') return customerHasPriorOrder === true;
  // unknown segment → fail closed.
  return false;
}

/**
 * Usage limits are read-only eligibility:
 *  - total:        used_count < usage_limit_total
 *  - per-customer: this customer's redemption count < usage_limit_per_customer
 * A null limit means unlimited.
 */
export function usageUnderLimits(
  c: Pick<CandidateDiscount, 'usageLimitTotal' | 'usageLimitPerCustomer' | 'usedCount'>,
  customerUsage: number,
): boolean {
  if (c.usageLimitTotal != null && c.usedCount >= c.usageLimitTotal) return false;
  if (c.usageLimitPerCustomer != null && customerUsage >= c.usageLimitPerCustomer) return false;
  return true;
}

/**
 * The discount's scope intersects the cart: `all` always does; `products`/`categories`
 * need at least one matching line item. (An empty cart never intersects a scoped
 * discount; an `all` discount on an empty cart yields a zero base downstream.)
 */
export function scopeIntersectsCart(c: CandidateDiscount, cart: DiscountCartSnapshot): boolean {
  if (c.appliesTo === 'all') return true;
  const targets = new Set(c.targetIds ?? []);
  if (targets.size === 0) return false;
  if (c.appliesTo === 'products') {
    return cart.items.some((i) => targets.has(i.productId));
  }
  // categories
  return cart.items.some((i) => {
    const cats = cart.productCategories.get(i.productId);
    return cats ? [...cats].some((cat) => targets.has(cat)) : false;
  });
}
