/**
 * Cart domain types.
 *
 * The Redis blob is the source of truth during a session. These types define
 * the in-memory / serialised shape. Postgres columns are written via CartFlushService.
 */

export interface CartAddress {
  name: string;
  company?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  postalCode: string;
  region?: string | null;
  country: string; // ISO 3166-1 alpha-2 upper-cased
  phone?: string | null;
}

export interface CartLineItem {
  id: string;
  variantId: string;
  quantity: number;
  /** Snapshot of unit price at add-time, integer minor units. */
  unitPriceAmount: number;
  currency: string;
  /**
   * Display-identity snapshot captured at add-time. Like the price snapshot,
   * these are stable against a LATER product/variant rename, unpublish, or delete — the cart shows
   * what the customer actually added. The storefront renders these (never the raw variantId UUID).
   */
  /** Product title at add-time. */
  productTitle: string;
  /** Variant title at add-time (nullable — a single-variant product may have none). */
  variantTitle: string | null;
  /** Variant option map at add-time (e.g. `{ Size: 'M', Color: 'Blue' }`). */
  options: Record<string, unknown>;
  /** Variant SKU at add-time. */
  sku: string;
  /** Product slug at add-time, for linking the line back to its PDP. */
  productSlug: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CartTotals {
  subtotal: number;
  shipping: number;
  /** Discount applied to the cart (integer minor units), computed by the 2.5 engine. */
  discountTotal: number;
  /** Always 0 — no-op resolver (replaced later). */
  taxTotal: number;
  grandTotal: number;
  currency: string;
  /**
   * Whether B2B reverse charge was applied by the authoritative tax resolution.
   * True IFF a resolved tax line carries `reverseCharge` — a VIES-validated B2B cross-border-EU sale where
   * the SELLER charges 0% VAT and the buyer self-accounts. Optional + defaults to false so it is
   * additive/back-compat: legacy/Postgres-recovery totals literals omit it (treated as false), and no
   * migration is needed (totals are COMPUTED from the tax engine, never a stored column). The storefront
   * reads THIS flag — never an inference from `taxTotal === 0`, which false-positives on the `none` regime,
   * no-destination carts, zero-rated jurisdictions, and non-EU exports.
   */
  reverseCharge?: boolean;
}

/**
 * Full in-memory cart state stored as a JSON blob in Redis.
 * All dates are stored as ISO-8601 strings in Redis (serialised through JSON).
 */
export interface CartState {
  id: string;
  tenantId: string;
  customerId: string | null;
  sessionToken: string;
  currency: string;
  status: 'active' | 'converted' | 'abandoned';
  guestEmail: string | null;
  items: CartLineItem[];
  shippingAddress: CartAddress | null;
  billingAddress: CartAddress | null;
  shippingRateId: string | null;
  /** Resolved shipping cost (integer minor units) for the chosen rate; 0 if none.
   *  Persisted in state so it survives item mutations (totals are recomputed with
   *  THIS value, never re-derived to 0). */
  shippingAmount: number;
  /** The ONE explicit discount code applied to this cart; null = none.
   *  Automatic (null-code) discounts always evaluate and stack independently of this. */
  discountCode: string | null;
  totals: CartTotals;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
