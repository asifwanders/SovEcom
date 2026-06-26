import { uuidv7 } from 'uuidv7';

/**
 * Follow-up B2 — ProductStockChangedEvent.
 *
 * Emitted AFTER a stock write that FLIPS a variant's AVAILABILITY across the zero boundary — i.e.
 * only on an out-of-stock ↔ in-stock transition, never on every decrement. The payload exposes a
 * back-in-stock/available BOOLEAN ONLY (`available`), NEVER the exact stock level or quantity:
 * exposing precise inventory to a sandboxed module is a competitive-information leak, and the boolean
 * is all a back-in-stock notifier needs. `available` reflects PHYSICAL stock crossing zero (NOT
 * stock-minus-active-reservations).
 *
 * Always emitted POST-COMMIT by the caller that owns the stock-mutating transaction (the admin
 * variant-update path and the order/refund inventory paths) so a module never enters — nor can block
 * — the transactional inventory path. It only OBSERVES.
 *
 * `eventId` is a unique-per-emit opaque id (generated at construction) — the module-facing
 * idempotency key, distinct for every flip even when two flips carry the same `available` value.
 *
 * The module-facing payload (see `module-event.listener.ts`) is
 * `{ eventId, productId, variantId, available }`.
 */
export class ProductStockChangedEvent {
  static readonly EVENT = 'product.stock_changed' as const;

  /** Unique-per-emit opaque id (the module-facing idempotency key). */
  public readonly eventId: string = uuidv7();

  constructor(
    public readonly tenantId: string,
    public readonly productId: string,
    public readonly variantId: string,
    /** True if the variant transitioned to IN-STOCK (0 → positive); false on positive → 0. */
    public readonly available: boolean,
  ) {}
}
