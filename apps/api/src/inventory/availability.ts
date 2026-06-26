/**
 * Follow-up B2 — the single definition of a variant's BACK-IN-STOCK availability for the
 * `product.stock_changed` observational event. A variant is "available" when it has positive
 * physical stock OR it allows backorder (a backorder variant is buyable at zero stock, so it never
 * flips out of availability on depletion). The module-facing `product.stock_changed` boolean uses
 * THIS function on the before/after stock so the price/admin path and the order/refund inventory
 * path agree on what a flip is. NEVER exposes the level itself — only this boolean.
 */
export function variantAvailable(stockQuantity: number, allowBackorder: boolean): boolean {
  return allowBackorder || stockQuantity > 0;
}

/**
 * The availability FLIP for a single variant across a stock write, or `null` when availability did
 * not cross the zero boundary (no flip → no event). `allowBackorder` is taken as constant across the
 * write (the inventory paths never change it), so the flip is purely driven by stock crossing zero.
 */
export function availabilityFlip(
  beforeStock: number,
  afterStock: number,
  allowBackorder: boolean,
): boolean | null {
  const was = variantAvailable(beforeStock, allowBackorder);
  const now = variantAvailable(afterStock, allowBackorder);
  return was === now ? null : now;
}
