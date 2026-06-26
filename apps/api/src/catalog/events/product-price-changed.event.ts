import { uuidv7 } from 'uuidv7';

/**
 * Follow-up B2 — ProductPriceChangedEvent.
 *
 * Emitted AFTER a variant's price ACTUALLY changes (old !== new), observationally, so subscribed
 * modules can react to a price drop/rise. Prices are PUBLIC catalog data, so carrying BOTH the old
 * and new minor-unit price is safe — it is exactly what a module needs to detect a drop without a
 * second read. NEVER emitted on a no-op price update.
 *
 * `eventId` is a unique-per-emit opaque id (generated here, at construction, so every emit gets a
 * fresh one) — the module-facing idempotency key. Two genuinely distinct drops that happen to share
 * the same {old,new} values (a flash-sale cycle) carry DIFFERENT `eventId`s, so a module never
 * mis-dedupes the second real drop as a redelivery.
 *
 * The module-facing payload (see `module-event.listener.ts`) is the minimal projection
 * `{ eventId, productId, variantId, oldPriceMinor, newPriceMinor, currency }`.
 */
export class ProductPriceChangedEvent {
  static readonly EVENT = 'product.price_changed' as const;

  /** Unique-per-emit opaque id (the module-facing idempotency key). */
  public readonly eventId: string = uuidv7();

  constructor(
    public readonly tenantId: string,
    public readonly productId: string,
    public readonly variantId: string,
    public readonly oldPriceMinor: number,
    public readonly newPriceMinor: number,
    public readonly currency: string,
  ) {}
}
