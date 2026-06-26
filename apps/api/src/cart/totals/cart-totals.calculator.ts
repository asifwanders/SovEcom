/**
 *  2.5 / 2.6 — CartTotalsCalculator.
 *
 * Computes server-side totals on every cart mutation. As of 2.5 the discount total
 * is computed OUTSIDE this class (DB-backed DiscountEngine) and passed IN; as of 2.6
 * the tax total is ALSO computed outside (TaxesService → the selected TaxResolver)
 * and passed IN — exactly the same seam, so the calculator stays a pure, synchronous,
 * in-memory function. All values are integer minor units (cents). Never trust client totals.
 *
 *   subtotal   = Σ(qty × unitPriceAmount)
 *   shipping   = from shipping_rates once a method is chosen, else 0
 *   discount   = passed in (DiscountEngine result); clamped to [0, subtotal]
 *   tax        = passed in (TaxesService result); integer minor units, ≥ 0
 *   grandTotal:
 *     - tax-EXCLUSIVE (prices do NOT include tax): tax is charged ON TOP →
 *         grandTotal = subtotal − discount + shipping + tax
 *     - tax-INCLUSIVE (prices ALREADY include tax): `tax` is the portion EXTRACTED
 *       from the gross subtotal/shipping, NOT an extra charge → it is already inside
 *       subtotal + shipping, so it is NOT added again →
 *         grandTotal = subtotal − discount + shipping
 *       (`taxTotal` is reported for display/invoicing but does not inflate the total.)
 */
import type { CartLineItem, CartTotals } from '../cart.types';

export class CartTotalsCalculator {
  /**
   * Recompute totals from items + optional shipping + a pre-computed discount + a
   * pre-computed tax.
   *
   * @param items           Current line items.
   * @param shippingAmount  Integer minor units. Null = not yet chosen (treated as 0).
   * @param discountTotal   Integer minor units from the DiscountEngine (default 0).
   *   Re-clamped to [0, subtotal] defensively so a stale value can't drive the total negative.
   * @param taxTotal        Integer minor units from the TaxResolver (default 0), ≥ 0.
   * @param pricesIncludeTax  When true, `taxTotal` is the EXTRACTED portion already in
   *   the prices (do NOT add it to grandTotal); when false, tax is added on top.
   */
  /**
   * @param reverseCharge Whether the authoritative tax resolution applied B2B reverse charge (
   *2c). The caller derives this from the tax engine's resolved LINES (`TaxLine.reverseCharge`)
   *   NEVER from `taxTotal === 0` — `taxTotal` is 0 in many non-reverse-charge cases (`none` regime,
   *   no-destination, zero-rated, non-EU export), so the flag must ride the computed totals separately.
   *   Default false (back-compat for callers that pass no tax context).
   */
  compute(
    items: CartLineItem[],
    shippingAmount: number | null,
    discountTotal = 0,
    taxTotal = 0,
    pricesIncludeTax = false,
    reverseCharge = false,
  ): Omit<CartTotals, 'currency'> {
    const subtotal = items.reduce((sum, i) => sum + i.unitPriceAmount * i.quantity, 0);
    const shipping = shippingAmount ?? 0;
    const discount = Math.max(0, Math.min(discountTotal, subtotal));
    const tax = Math.max(0, taxTotal);

    // Tax-inclusive: the tax is already inside subtotal + shipping (it was extracted,
    // not added) → do not add it again. Tax-exclusive: tax is charged on top.
    const grandTotal = pricesIncludeTax
      ? subtotal - discount + shipping
      : subtotal - discount + shipping + tax;

    return {
      subtotal,
      shipping,
      discountTotal: discount,
      taxTotal: tax,
      grandTotal,
      reverseCharge,
    };
  }
}
