/**
 * Pure order-snapshot + server-side totals recompute.
 *
 * `createFromCart` must NEVER trust the Redis cart's totals blob. These pure functions take
 * the expanded order lines (after bundle expansion) + the tax/discount/shipping context and:
 *   1. Apportion the goods/items tax across goods lines via largest-remainder so the
 *      per-line tax sums exactly to the items-tax total (no rounding drift). Shipping VAT is
 *      kept as an order-level amount and is never smeared into goods lines.
 *   2. Stamp each line's `tax_rate` to the statutory destination rate (a fraction < 1) — never
 *      a blended ratio that could overflow the database column's precision.
 *   3. Allocate the discount across lines the same way.
 *   4. Compute each line's `lineTotalAmount` and the order's subtotal/discount/tax/shipping/
 *      grand totals.
 * All money is integer minor units; never floats.
 */

/** A snapshot line BEFORE tax/discount allocation: the priced, expanded order line. */
export interface SnapshotLineInput {
  /** Variant id (null only for a never-expected missing variant — kept for the FK). */
  variantId: string;
  productTitle: string;
  variantTitle: string | null;
  sku: string;
  quantity: number;
  /** Integer minor units. */
  unitPriceAmount: number;
  /**
   * True for the PARENT line of a bundle: it carries the bundle's price + tax, but its
   * CONSTITUENT stock was consumed via the component variants. Component snapshot lines
   * are NOT emitted as priced order_items (they'd double-count); only the parent is priced.
   * (We keep bundle decomposition in inventory only — see createFromCart.)
   */
  isBundleParent?: boolean;
}

/**
 * The split tax context the snapshot apportions. The tax engine resolves the
 * cart into two components — an "Items" component (goods, the only thing apportioned across
 * order_items) and a separate "Shipping" component (kept order-level). `itemsRate` is the
 * statutory destination rate as a fraction (e.g. 0.2 for 20%) — what `order_items.tax_rate`
 * stores, never a blended ratio that could overflow the database column precision.
 */
export interface TaxBreakdown {
  /** Σ tax on the goods/items component, integer minor units (apportioned across lines). */
  itemsTax: number;
  /** Statutory rate applied to the items component, as a fraction (0 when no VAT). */
  itemsRate: number;
  /** Tax on the shipping component, integer minor units (kept order-level, NOT per-line). */
  shippingTax: number;
  /**
   * Tax-inclusive zero-rated orders only (B2B reverse charge / non-EU export). The
   * catalogue unit prices are gross (VAT embedded), but no VAT is charged, so the embedded
   * VAT must be removed from the booked total: this is the net items base the resolver
   * re-derived by stripping the would-be rate. When set (taxInclusive only), the snapshot
   * books this net instead of the gross subtotal. Undefined for every normal order.
   */
  inclusiveItemsNet?: number;
  /**
   * As {@link inclusiveItemsNet}, for the shipping component (net of embedded VAT).
   */
  inclusiveShippingNet?: number;
}

/** A fully-resolved order line ready to insert into `order_items`. */
export interface SnapshotLine extends SnapshotLineInput {
  /**
   * The STATUTORY destination rate as a fraction (e.g. 0.2 for 20%), NOT a blended
   * `lineTax/lineNet` — so it always fits numeric(5,4). 0 for a zero-net (fully-discounted)
   * line or a no-VAT order.
   */
  taxRate: number;
  /** Integer minor units, ≥ 0: this line's apportioned share of the ITEMS tax (excl. shipping). */
  taxAmount: number;
  /** Integer minor units, ≥ 0: net line goods + this line's items-tax share (excl. shipping). */
  lineTotalAmount: number;
}

/** The computed, authoritative order totals (integer minor units). */
export interface OrderTotals {
  subtotalAmount: number;
  discountAmount: number;
  /** Items tax + shipping tax (the WHOLE order tax). */
  taxAmount: number;
  shippingAmount: number;
  totalAmount: number;
}

export interface BuiltSnapshot {
  lines: SnapshotLine[];
  totals: OrderTotals;
}

/**
 * Largest-remainder apportionment of `total` across `weights` (all ≥ 0). Returns an integer
 * array summing EXACTLY to `total`. When every weight is 0 (e.g. tax 0), returns all zeros.
 */
export function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);

  const exact = weights.map((w) => (total * w) / sum);
  const floored = exact.map((x) => Math.floor(x));
  let remainder = total - floored.reduce((s, x) => s + x, 0);

  // Distribute the leftover units to the largest fractional parts first.
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);

  const out = [...floored];
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) {
    out[order[k]!.i]! += 1;
  }
  return out;
}

/**
 * Build the order line snapshot + reconciled totals from the priced lines and the
 * server-resolved discount/tax/shipping. `taxInclusive` controls whether the resolved tax is
 * ADDED on top (exclusive) or already inside the line prices (inclusive).
 *
 * Allocation:
 *  - subtotal = Σ(qty × unitPrice) over priced lines.
 *  - discount is apportioned across lines by each line's GROSS goods weight.
 *  - the ITEMS tax (NOT shipping tax) is apportioned across lines by each line's NET goods
 *    weight so the per-line tax sums to `tax.itemsTax` EXACTLY. Each line's `taxRate` is the
 *    STATUTORY `tax.itemsRate` (0 when the line's net is 0).
 *  - SHIPPING tax stays order-level: it is in `totals.taxAmount` but NEVER in any line.
 *  - lineTotal = net − (already in net) + (exclusive ? lineItemsTax : 0).
 *  - grandTotal = subtotal − discount + shipping + (exclusive ? itemsTax + shippingTax : 0).
 *
 * @throws Error if any invariant fails (per-line tax ≠ items-tax; order tax ≠ items+shipping;
 *   negative money) — a bug guard, surfaced to the caller as a 500 rather than shipping bad money.
 */
export function buildSnapshot(
  inputs: SnapshotLineInput[],
  discountTotal: number,
  tax: TaxBreakdown,
  shippingAmount: number,
  taxInclusive: boolean,
): BuiltSnapshot {
  const grossGoods = inputs.map((l) => l.unitPriceAmount * l.quantity);
  const grossSubtotal = grossGoods.reduce((s, x) => s + x, 0);

  // tax-INCLUSIVE zero-rated order: strip the embedded VAT. The catalogue prices are
  // GROSS; with no VAT charged the booked subtotal must be the resolver's NET (the embedded
  // VAT removed), apportioned back across lines by their gross weight so the per-line totals
  // reconcile. ONLY when taxInclusive AND the resolver supplied a net (reverse charge / export);
  // every other order keeps the gross (the `none` regime / inclusive-B2C VAT is genuinely paid).
  const stripInclusive = taxInclusive && tax.inclusiveItemsNet != null;
  const lineGoods = stripInclusive
    ? apportion(Math.max(0, Math.min(tax.inclusiveItemsNet!, grossSubtotal)), grossGoods)
    : grossGoods;
  const subtotal = lineGoods.reduce((s, x) => s + x, 0);

  const discount = Math.max(0, Math.min(discountTotal, subtotal));
  const itemsTax = Math.max(0, Math.round(tax.itemsTax));
  const shippingTax = Math.max(0, Math.round(tax.shippingTax));
  const itemsRate = tax.itemsRate > 0 ? tax.itemsRate : 0;
  // Inclusive zero-rated shipping is booked NET too (its embedded VAT stripped by the resolver).
  const shipping =
    taxInclusive && tax.inclusiveShippingNet != null
      ? Math.max(0, Math.min(tax.inclusiveShippingNet, shippingAmount))
      : Math.max(0, shippingAmount);

  // Apportion discount by gross goods weight, then the ITEMS tax by NET goods weight.
  const lineDiscount = apportion(discount, lineGoods);
  const lineNet = lineGoods.map((g, i) => Math.max(0, g - lineDiscount[i]!));
  const lineTax = apportion(itemsTax, lineNet);

  const lines: SnapshotLine[] = inputs.map((input, i) => {
    const net = lineNet[i]!;
    const t = lineTax[i]!;
    // Statutory rate (a clean fraction that always fits numeric(5,4)); 0 for a zero-net line.
    const rate = net > 0 ? itemsRate : 0;
    const lineTotal = net + (taxInclusive ? 0 : t);
    return {
      ...input,
      taxRate: rate,
      taxAmount: t,
      lineTotalAmount: lineTotal,
    };
  });

  // The whole order tax = items tax + shipping tax. Shipping tax is order-level only.
  const orderTax = itemsTax + shippingTax;
  const grandTotal = subtotal - discount + shipping + (taxInclusive ? 0 : orderTax);

  const totals: OrderTotals = {
    subtotalAmount: subtotal,
    discountAmount: discount,
    taxAmount: orderTax,
    shippingAmount: shipping,
    totalAmount: grandTotal,
  };

  assertReconciles(lines, totals, { itemsTax, shippingTax }, taxInclusive);
  return { lines, totals };
}

/** Reconciliation guard — every order MUST equal a server-side recompute. */
function assertReconciles(
  lines: SnapshotLine[],
  totals: OrderTotals,
  tax: { itemsTax: number; shippingTax: number },
  taxInclusive: boolean,
): void {
  // (1) Per-line tax sums to the ITEMS tax exactly (shipping tax is NOT smeared into lines).
  const taxSum = lines.reduce((s, l) => s + l.taxAmount, 0);
  if (taxSum !== tax.itemsTax) {
    throw new Error(
      `order items-tax reconcile failed: lines ${taxSum} ≠ items-tax ${tax.itemsTax}`,
    );
  }
  // (2) The order tax = items tax + shipping tax.
  if (totals.taxAmount !== tax.itemsTax + tax.shippingTax) {
    throw new Error(
      `order tax reconcile failed: total ${totals.taxAmount} ≠ items ${tax.itemsTax} + shipping ${tax.shippingTax}`,
    );
  }
  // (3) Each line's stored rate must fit numeric(5,4) — a statutory fraction, never blended.
  for (const l of lines) {
    if (l.taxRate < 0 || l.taxRate > 9.9999) {
      throw new Error(`order line tax_rate ${l.taxRate} out of numeric(5,4) range`);
    }
  }
  // (4) lineTotal includes per-line items-tax only when exclusive; reconcile the goods-net portion.
  const lineGoodsNet = lines.reduce(
    (s, l) => s + (l.lineTotalAmount - (taxInclusive ? 0 : l.taxAmount)),
    0,
  );
  const expectedGoodsNet = totals.subtotalAmount - totals.discountAmount;
  if (lineGoodsNet !== expectedGoodsNet) {
    throw new Error(
      `order goods reconcile failed: lines ${lineGoodsNet} ≠ subtotal−discount ${expectedGoodsNet}`,
    );
  }
  for (const v of [
    totals.subtotalAmount,
    totals.discountAmount,
    totals.taxAmount,
    totals.shippingAmount,
    totals.totalAmount,
  ]) {
    if (v < 0 || !Number.isInteger(v)) {
      throw new Error(`order total invariant failed: non-integer/negative money ${v}`);
    }
  }
}
