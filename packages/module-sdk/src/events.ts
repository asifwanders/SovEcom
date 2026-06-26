/**
 * Follow-up B2 — the MODULE-FACING payload contracts for the two OBSERVATIONAL commerce events a
 * module may subscribe to (`product.price_changed`, `product.stock_changed`). These are the EXACT
 * shapes core fans to a subscribed worker's event handler, so they are part of the published SDK
 * contract: a change here is a contract change. `apps/api` (the core runtime) imports these FROM
 * here, so what the broker delivers can never drift from what a module author types against.
 *
 * Both are deliberately minimal, NON-PII projections. Modules only OBSERVE these signals — emitting
 * them stays entirely inside core's transactional/admin paths (a module never enters them).
 */

/**
 * `eventId` — an opaque, core-assigned identifier that is UNIQUE PER EMIT. Two genuinely distinct
 * events (e.g. a flash-sale cycle that drops a variant to the SAME price TWICE) carry DIFFERENT
 * `eventId`s, so a module can use it as an idempotency key that dedupes only redelivery/reprocessing
 * of the SAME event — never two real events that happen to share the same {old,new} values. (Core
 * delivery is at-most-once today, but a module persisting a dedup ledger must key on this, not on
 * the collision-prone value tuple.) Treat it as opaque — do not parse it.
 */

/**
 * `product.price_changed` — a variant's price ACTUALLY changed (old !== new). Prices are PUBLIC
 * catalog data, so carrying BOTH the old and new minor-unit price is safe and is exactly what a
 * module needs to detect a drop without a second read. NEVER delivered on a no-op price update.
 */
export interface ProductPriceChangedPayload {
  /** Opaque, core-assigned, unique-per-emit id — the correct module-side idempotency key. */
  readonly eventId: string;
  readonly productId: string;
  readonly variantId: string;
  readonly oldPriceMinor: number;
  readonly newPriceMinor: number;
  readonly currency: string;
}

/**
 * `product.stock_changed` — a variant's AVAILABILITY flipped across the zero boundary. Carries a
 * back-in-stock BOOLEAN ONLY: `available: true` on an out-of-stock → in-stock (0 → positive)
 * transition, `false` on in-stock → out-of-stock. It NEVER carries the exact stock level / quantity
 * — exposing precise inventory to a sandboxed module is a competitive-information leak, and the
 * boolean is all a back-in-stock notifier needs. `available` reflects PHYSICAL stock crossing zero
 * (NOT stock-minus-active-reservations).
 */
export interface ProductStockChangedPayload {
  /** Opaque, core-assigned, unique-per-emit id — the correct module-side idempotency key. */
  readonly eventId: string;
  readonly productId: string;
  readonly variantId: string;
  readonly available: boolean;
}
