/**
 * DiscountEngine. PURE, no DB, no floats.
 *
 * `evaluate(input) → AppliedDiscount[]` takes a cart snapshot + candidate discounts
 * + a segment/usage context and returns the deterministic ordered list of applied
 * discounts (each with its integer amount). The service layer loads candidates and
 * builds the context; this class only computes money.
 *
 * Money is ALWAYS integer minor units (cents). Never floats.
 *
 * Algorithm:
 *  1. Eligibility filter — active, date range, min_cart, segment, usage-not-exhausted,
 *     currency match (fixed only), scope target_ids intersect the cart.
 *  2. Applicable BASE per `applies_to`:
 *       all        → subtotal
 *       products   → Σ line items whose variant's product ∈ target_ids
 *       categories → Σ line items whose product ∈ a category in target_ids
 *  3. Compute (integer): percentage → round_half_up(base × value / 10000);
 *     fixed → min(value, base). Each applies to the ORIGINAL base (NON-compounding).
 *     Every amount clamped to [0, base].
 *  4. Stacking: among NON-stackable pick the single LARGEST-saving one; apply all
 *     stackable on top (largest-saving first). Total clamped so grandTotal ≥ 0.
 *  5. Return ordered AppliedDiscount[] — deterministic (ties broken by id).
 *
 * ROUNDING RULE (documented): percentages round HALF UP to the minor
 * unit — `floor((base × value + 5000) / 10000)` since base, value ≥ 0. A discount
 * never exceeds its base. Example: 33% of 1000 = 330 (3300000/10000 = 330 exactly);
 * 33% of 1001 = round_half_up(330.33) = 330; 50% of 1001 = round_half_up(500.5) = 501.
 */

/** A cart line item as the engine sees it (price already snapshotted). */
export interface DiscountLineItem {
  /** The product this variant belongs to (for products/categories scope). */
  productId: string;
  /** Integer minor units. */
  unitPriceAmount: number;
  quantity: number;
}

/** The immutable cart snapshot the engine evaluates against. */
export interface DiscountCartSnapshot {
  currency: string;
  /** Σ(unitPriceAmount × quantity) over all items — integer minor units. */
  subtotal: number;
  items: DiscountLineItem[];
  /** Set of category ids each product belongs to (for the `categories` scope). */
  productCategories: Map<string, Set<string>>;
}

/** Discount type — mirrors the `discount_type` pg enum (percentage | fixed ONLY). */
export type DiscountType = 'percentage' | 'fixed';

/** Discount scope — mirrors the `discount_scope` pg enum (all | products | categories). */
export type DiscountScope = 'all' | 'products' | 'categories';

/**
 * A candidate discount, normalised from the DB row + per-customer usage context.
 * `value` is integer (percent ×100 for percentage; fixed minor units for fixed).
 */
export interface CandidateDiscount {
  id: string;
  code: string | null;
  type: DiscountType;
  /** percent ×100 (percentage) OR fixed minor units (fixed). Non-negative. */
  value: number;
  /** Only meaningful for `fixed`; when set, must equal the cart currency. */
  currency: string | null;
  minCartAmount: number | null;
  appliesTo: DiscountScope;
  /** product ids (products scope) or category ids (categories scope); null/[] for `all`. */
  targetIds: string[] | null;
  /** 'all' | 'b2b' | 'first_time' | 'returning' — all evaluable (the last two via the
   * context's `customerHasPriorOrder` order-history signal). */
  customerSegment: string | null;
  stackable: boolean;
  usageLimitTotal: number | null;
  usageLimitPerCustomer: number | null;
  /** Total redemptions so far (discounts.used_count). */
  usedCount: number;
  startsAt: Date | null;
  endsAt: Date | null;
  active: boolean;
}

/** The customer/usage context for an evaluation. */
export interface DiscountEvalContext {
  /** True when the cart's customer is a B2B account (customers.is_b2b). */
  isB2b: boolean;
  /** Per-customer redemption counts keyed by discount id (from discount_usages). */
  perCustomerUsage: Map<string, number>;
  /**
   * Order-history signal for the `first_time`/`returning` segments:
   *  - `true`  → the cart owner has ≥1 prior non-cancelled order  → `returning` matches.
   *  - `false` → the cart owner has no prior order                → `first_time` matches.
   *  - `undefined`/`null` → a GUEST cart (no customer) → NEITHER segment matches.
   * The service builds this from a tenant-scoped COUNT on the orders table.
   */
  customerHasPriorOrder?: boolean | null;
  /** Evaluation instant — defaults to now; injectable for deterministic tests. */
  now?: Date;
}

export interface DiscountEvalInput {
  cart: DiscountCartSnapshot;
  candidates: CandidateDiscount[];
  context: DiscountEvalContext;
}

/** A computed, applied discount (deterministic, ordered). */
export interface AppliedDiscount {
  discountId: string;
  code: string | null;
  /** Integer minor units actually discounted (already clamped). */
  amount: number;
  scope: DiscountScope;
}

export interface DiscountEvalResult {
  applied: AppliedDiscount[];
  /** Σ of applied amounts, clamped so it never exceeds the subtotal. */
  discountTotal: number;
}

/**
 * round_half_up(base × value / 10000) with integer math. base, value ≥ 0 so a plain
 * +5000 then floor is exact half-up (no negative-rounding ambiguity). Documented above.
 */
function percentAmount(base: number, value: number): number {
  return Math.floor((base * value + 5000) / 10000);
}

export class DiscountEngine {
  /**
   * Pure evaluation. Returns the deterministic applied-discount list + clamped total.
   */
  evaluate(input: DiscountEvalInput): DiscountEvalResult {
    const { cart, candidates, context } = input;
    const now = context.now ?? new Date();

    // ── 1. Eligibility + 2/3. base + amount, in one pass ──────────────────────
    type Scored = AppliedDiscount & { stackable: boolean };
    const scored: Scored[] = [];

    for (const c of candidates) {
      if (!this.isEligible(c, cart, context, now)) continue;
      const base = this.applicableBase(c, cart);
      if (base <= 0) continue; // nothing to discount against
      const raw = c.type === 'percentage' ? percentAmount(base, c.value) : Math.min(c.value, base);
      const amount = clamp(raw, 0, base);
      if (amount <= 0) continue; // a zero-value discount contributes nothing
      scored.push({
        discountId: c.id,
        code: c.code,
        amount,
        scope: c.appliesTo,
        stackable: c.stackable,
      });
    }

    // ── 4. Stacking ───────────────────────────────────────────────────────────
    const applied = this.resolveStacking(scored);

    // ── Total, clamped so grandTotal ≥ 0 (never discount more than the subtotal) ─
    let discountTotal = 0;
    const clampedApplied: AppliedDiscount[] = [];
    for (const a of applied) {
      const room = cart.subtotal - discountTotal;
      if (room <= 0) {
        // No headroom left — append a zero-amount entry so the applied list still
        // reflects which discounts matched, but it adds nothing to the total.
        clampedApplied.push({ discountId: a.discountId, code: a.code, amount: 0, scope: a.scope });
        continue;
      }
      const amount = Math.min(a.amount, room);
      discountTotal += amount;
      clampedApplied.push({ discountId: a.discountId, code: a.code, amount, scope: a.scope });
    }

    return { applied: clampedApplied, discountTotal };
  }

  // ── Eligibility (delegates the rule checks to rule-validators) ───────────────

  private isEligible(
    c: CandidateDiscount,
    cart: DiscountCartSnapshot,
    ctx: DiscountEvalContext,
    now: Date,
  ): boolean {
    if (!c.active) return false;
    if (!withinDateRange(c.startsAt, c.endsAt, now)) return false;
    if (!meetsMinCart(c.minCartAmount, cart.subtotal)) return false;
    if (!segmentMatches(c.customerSegment, ctx.isB2b, ctx.customerHasPriorOrder)) return false;
    if (!usageUnderLimits(c, ctx.perCustomerUsage.get(c.id) ?? 0)) return false;
    // currency match (fixed only): a fixed discount in another currency is rejected.
    if (c.type === 'fixed' && c.currency != null && c.currency !== cart.currency) return false;
    if (!scopeIntersectsCart(c, cart)) return false;
    return true;
  }

  // ── Applicable base per applies_to ───────────────────────────────────────────

  private applicableBase(c: CandidateDiscount, cart: DiscountCartSnapshot): number {
    if (c.appliesTo === 'all') return cart.subtotal;
    const targets = new Set(c.targetIds ?? []);
    if (c.appliesTo === 'products') {
      return cart.items.reduce(
        (sum, i) => (targets.has(i.productId) ? sum + i.unitPriceAmount * i.quantity : sum),
        0,
      );
    }
    // categories: a line counts if its product belongs to ANY target category.
    return cart.items.reduce((sum, i) => {
      const cats = cart.productCategories.get(i.productId);
      const matches = cats ? [...cats].some((cat) => targets.has(cat)) : false;
      return matches ? sum + i.unitPriceAmount * i.quantity : sum;
    }, 0);
  }

  // ── Stacking resolution ───────────────────────────────────────────────

  private resolveStacking<T extends { amount: number; discountId: string; stackable: boolean }>(
    scored: T[],
  ): T[] {
    return resolveStacking(scored);
  }
}

// Re-export the helpers' implementations from sibling modules so this file stays the
// single import surface for the engine while the rule/stacking logic lives separately.
import { clamp } from './rule-validators';
import {
  withinDateRange,
  meetsMinCart,
  segmentMatches,
  usageUnderLimits,
  scopeIntersectsCart,
} from './rule-validators';
import { resolveStacking } from './stacking-resolver';

export { percentAmount };
