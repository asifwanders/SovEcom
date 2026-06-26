/**
 * Cart merge utility (guest→customer).
 *
 * Merges two item lists: union line items; for a variant present in both, SUM
 * quantities clamped to available stock (if provided). Discounts are deferred
 * (currently a no-op). The merged result is the set of items for the surviving cart.
 */
import type { CartLineItem } from './cart.types';

/** Stock context for a variant during a merge. */
export interface MergeStockInfo {
  stock: number;
  allowBackorder: boolean;
}

/** Clamp a summed quantity to stock — UNLESS backorder is allowed (then keep it).
 *  Unknown variant (no stock info) → no clamp. */
function clampToStock(qty: number, info: MergeStockInfo | undefined): number {
  if (!info || info.allowBackorder) return qty;
  return Math.min(qty, info.stock);
}

/**
 * Merge guest + customer item lists.
 * @param guestItems    Items from the guest cart.
 * @param customerItems Items from the existing customer cart.
 * @param stockMap      Map of variantId → stock context. Empty map = no clamping.
 * @returns             Merged item list (new objects, updatedAt reset).
 */
export function mergeCartItems(
  guestItems: CartLineItem[],
  customerItems: CartLineItem[],
  stockMap: Record<string, MergeStockInfo>,
): CartLineItem[] {
  const now = new Date();
  // Build a map keyed by variantId. Start with customer items.
  const merged = new Map<string, CartLineItem>();

  for (const item of customerItems) {
    merged.set(item.variantId, { ...item, updatedAt: now });
  }

  for (const guestItem of guestItems) {
    const existing = merged.get(guestItem.variantId);
    const base = existing ? existing.quantity : 0;
    // Clamp the SUMMED quantity to stock, but never below a backorder line.
    const quantity = clampToStock(base + guestItem.quantity, stockMap[guestItem.variantId]);
    const source = existing ?? guestItem;
    merged.set(guestItem.variantId, { ...source, quantity, updatedAt: now });
  }

  // Drop any line that clamped to <= 0 (a non-backorder variant with stock 0).
  // A zero-quantity item would violate cart_items_quantity_chk on flush and
  // permanently poison the Postgres backstop, so it must never enter the cart.
  // Backorder lines are never clamped above, so they survive here.
  return Array.from(merged.values()).filter((i) => i.quantity > 0);
}
