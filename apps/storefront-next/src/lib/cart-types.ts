/**
 * Cart view-types. Extracted from `cart-context.tsx` (the
 * constitution's <500-line rule) so the context module stays focused on the provider/runtime.
 *
 * These are the storefront-OWNED response view-types: client-js types request paths/bodies but NOT
 * response bodies, so the shapes below mirror the API `CartController.serialize` +
 * `CartTotals` (`apps/api/src/cart`). Pure types — no runtime, no React; importable from RSC or client.
 *
 * MONEY-CRITICAL: every money figure is an integer minor-unit value straight off the SERVER's
 * authoritative totals; the storefront never does cart/tax arithmetic on these.
 */

/**
 * A cart line item. `unitPriceAmount` is integer minor units (a price snapshot at add-time). The
 * display-identity fields (`productTitle`/`variantTitle`/`options`/`sku`/`productSlug`) are ALSO
 * snapshotted at add-time by the API — stable against a later rename/unpublish/
 * delete — so the storefront renders the human-readable name + a PDP link, never the raw variant UUID.
 */
export interface CartLineView {
  id: string;
  variantId: string;
  quantity: number;
  unitPriceAmount: number;
  currency: string;
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
}

/** Server-computed totals — integer minor units. The ONLY source of money truth (never client math). */
export interface CartTotalsView {
  subtotal: number;
  shipping: number;
  discountTotal: number;
  taxTotal: number;
  grandTotal: number;
  currency: string;
  /**
   * Whether the SERVER applied B2B reverse charge. The authoritative tax-engine decision — the
   * storefront reads THIS flag to show the reverse-charge note, NEVER an inference from `taxTotal === 0`
   * (which false-positives on edge cases). The API always serialises it as a concrete boolean.
   */
  reverseCharge: boolean;
}

/** The authoritative cart the API returns from every mutation/get. */
export interface CartView {
  id: string;
  customerId: string | null;
  currency: string;
  status: 'active' | 'converted' | 'abandoned';
  guestEmail: string | null;
  items: CartLineView[];
  shippingAddress: unknown | null;
  billingAddress: unknown | null;
  shippingRateId: string | null;
  discountCode: string | null;
  totals: CartTotalsView;
}

/** The `POST /store/v1/carts` body response: the (non-secret) cart id + its currency. */
export interface CreateCartResponse {
  cartId: string;
  currency: string;
}

/**
 * A shipping rate available for a cart destination (mirrors the API `AvailableRate` shape in
 * `apps/api/src/shipping/shipping.service.ts`). `amount` is the COMPUTED cost for this cart in integer
 * minor units (NOT the raw rate amount) — display it via `formatPrice`; never compute it client-side.
 */
export interface ShippingRateView {
  id: string;
  name: string;
  type: 'flat' | 'free_over' | 'weight_based';
  amount: number;
  currency: string;
}

/** A minimal destination for a cart-page shipping ESTIMATE (country + postal code only). */
export interface ShippingEstimateDestination {
  /** ISO-3166-1 alpha-2 country code (the API upper-cases + validates it). */
  country: string;
  /** Destination postal code. */
  postalCode: string;
}

/**
 * A full postal address for the checkout address step (mirrors the API `SetAddressDto` — `AddressSchema`
 * in `apps/api/src/cart/dto/cart.dto.ts`). `name`/`line1`/`city`/`postalCode`/`country` are REQUIRED;
 * the rest are optional. The `country` is a 2-letter ISO-3166 code (the API upper-cases it). This is the
 * REAL customer address — `setShippingAddress` posts it verbatim, overwriting any estimator placeholder.
 */
export interface CartAddressInput {
  name: string;
  company?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  postalCode: string;
  region?: string | null;
  country: string;
  phone?: string | null;
}

/** The cart context value exposed by `useCart()`. */
export interface CartContextValue {
  /** The authoritative cart, or `null` before one exists. */
  cart: CartView | null;
  /** Total item quantity across lines (derived from `cart.items`, for the header badge). */
  itemCount: number;
  /** Add a variant (optimistic count bump, rollback on error). */
  addItem: (variantId: string, quantity: number) => Promise<void>;
  /** Set a line's quantity (optimistic, rollback on error). */
  updateItem: (itemId: string, quantity: number) => Promise<void>;
  /** Remove a line. */
  removeItem: (itemId: string) => Promise<void>;
  /** Apply a discount code (422 if ineligible — surfaced as a thrown error). */
  applyDiscount: (code: string) => Promise<void>;
  /** Remove an applied discount code. */
  removeDiscount: (code: string) => Promise<void>;
  /** Re-read the authoritative cart from the server (no mutation). */
  refresh: () => Promise<void>;
  /**
   * Shipping rates last fetched by {@link estimateShipping} for the current destination, or `null`
   * before an estimate has run. Empty array = a destination was set but no rates serve it.
   */
  shippingRates: ShippingRateView[] | null;
  /**
   * Cart-page ESTIMATE: set a minimal destination (country + postal code) so the server can compute
   * available shipping rates, adopt the server's recomputed cart, then return its available rates.
   * Server-authoritative — totals + rate amounts come from the API, never client math. Throws on a
   * validation/server error (e.g. an unknown country); the cart is unchanged on a thrown error.
   */
  estimateShipping: (destination: ShippingEstimateDestination) => Promise<ShippingRateView[]>;
  /**
   * READ-ONLY rate fetch for the cart's CURRENT (already-set) shipping address — used by the checkout
   * shipping step once `setShippingAddress` has stored the REAL address. Unlike {@link estimateShipping}
   * it does NOT post an address, so it can NEVER overwrite the real address with the estimator
   * placeholder (the bug that otherwise clamps the flow back to the address step). Returns `[]` (and
   * leaves `shippingRates` null) when no address is set yet. Server-authoritative; no client math.
   */
  loadShippingRates: () => Promise<ShippingRateView[]>;
  /**
   * Select one of the estimated rates so the server folds its cost into the authoritative totals
   * (lets the cart page preview the grand total WITH shipping). Adopts the server cart.
   */
  selectShippingRate: (shippingRateId: string) => Promise<void>;
  /** Set the guest email on the cart (checkout step 1). Adopts the server cart. */
  setEmail: (email: string) => Promise<void>;
  /**
   * Set the REAL full shipping address (checkout step 2). UNCONDITIONALLY overwrites whatever is on the
   * cart — including any estimator placeholder — so a placeholder can never survive into a created order.
   */
  setShippingAddress: (address: CartAddressInput) => Promise<void>;
  /** Set the REAL full billing address (checkout step 2, when it differs from shipping). Adopts the cart. */
  setBillingAddress: (address: CartAddressInput) => Promise<void>;
  /**
   * Associate the authenticated customer with the cart (requires a Bearer; triggers the guest→customer
   * merge server-side). After this the server's tax engine sees the customer's B2B/VAT context, so a
   * cross-border EU B2B reverse-charge surfaces in the authoritative totals (the server sets
   * `totals.reverseCharge`). Adopts the server cart. No-op-safe to call more than once.
   */
  associateCustomer: () => Promise<void>;
  /**
   * Force a SERVER tax recompute and adopt the fresh authoritative totals. A plain
   * `refresh()` (`GET /carts`) only LOADS the cart — it does NOT re-run `recomputeCartTotals`, which lives
   * inside cart MUTATIONS. So after an in-checkout VAT change (`PATCH /customers/me` flips `vat_validated`)
   * the displayed `totals.taxTotal`/`reverseCharge` would go stale. This re-POSTs the cart's CURRENT real
   * shipping address via the existing `shipping-address` endpoint, which triggers a server recompute that
   * reads the LIVE customer VAT (`taxes.service.loadCustomerContext` re-selects `vat_validated` from the
   * customers row), then adopts the recomputed totals. No-op when no real shipping address is set yet (no
   * destination → tax is 0 regardless). Server-authoritative; no client tax math.
   */
  recomputeTotals: () => Promise<void>;
}
