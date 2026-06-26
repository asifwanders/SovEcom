/**
 * wishlist — core-event subscriptions (gated by `subscribe:events`).
 *
 * DIGEST WIRING (follow-up B2 — the gap is now CLOSED): core emits an OBSERVATIONAL
 * `product.price_changed` event carrying `{ productId, variantId, oldPriceMinor, newPriceMinor,
 * currency }` (prices are PUBLIC catalog data — old+new is safe and is exactly what drop detection
 * needs). The module subscribes to it and, on a real DROP (newPriceMinor < oldPriceMinor), feeds a
 * single-candidate run to the existing idempotent {@link runPriceDropDigest}: it matches the dropped
 * variant against who wishlisted it, dedupes on the per-(customer, variant, run) ledger, and emails
 * each matched customer via `sdk.email.sendToCustomer` (B3) — CORE resolves the recipient and
 * honours marketing consent + erasure; the module supplies only the `customerId`. The price
 * comparison no longer needs an out-of-band trigger.
 *
 * The module still ALSO subscribes to `product.updated` as a lightweight "a product changed" signal
 * (log-only, idempotent) — kept for parity with the original wiring; the price path is the live one.
 *
 * IDEMPOTENCY: event delivery is at-least-once. The digest's ledger (`markDigested`, UNIQUE-
 * constrained) makes a redelivered price event a no-op — the same (customer, variant, run) is only
 * emailed once. A malformed payload is tolerated (no throw, no send).
 */
import type { EventsClient, ProductPriceChangedPayload } from '@sovecom/module-sdk';
import { runPriceDropDigest, type PriceDropCandidate, type DigestResult } from '../digest/digest';

/** Narrow the untrusted event payload to the one field core sends for product.updated. */
function readProductId(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const id = (payload as { productId?: unknown }).productId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

/**
 * Narrow the untrusted `product.price_changed` payload to a typed drop, or null if it is malformed
 * or not actually a drop (we only act on newPriceMinor < oldPriceMinor). Validates every field —
 * the payload arrives over RPC and is never trusted by shape.
 */
function readPriceDrop(payload: unknown): ProductPriceChangedPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.eventId !== 'string' || p.eventId.length === 0) return null;
  if (typeof p.variantId !== 'string' || p.variantId.length === 0) return null;
  if (typeof p.productId !== 'string') return null;
  if (typeof p.oldPriceMinor !== 'number' || !Number.isInteger(p.oldPriceMinor)) return null;
  if (typeof p.newPriceMinor !== 'number' || !Number.isInteger(p.newPriceMinor)) return null;
  if (typeof p.currency !== 'string' || p.currency.length === 0) return null;
  // Only a genuine DROP is worth running the digest for (the digest re-checks this too).
  if (!(p.newPriceMinor < p.oldPriceMinor)) return null;
  return {
    eventId: p.eventId,
    productId: p.productId,
    variantId: p.variantId,
    oldPriceMinor: p.oldPriceMinor,
    newPriceMinor: p.newPriceMinor,
    currency: p.currency,
  };
}

/**
 * The dependencies the price-drop handler needs to run the digest. Injected at `activate` so the
 * handler stays pure/testable. `runDigest` defaults to {@link runPriceDropDigest} but is overridable
 * in tests. `digestRunId` derives the idempotency key per event so reprocessing the SAME event is a
 * no-op while two DISTINCT drops always fire.
 */
export interface PriceDropDeps {
  readonly runDigest?: typeof runPriceDropDigest;
  readonly digest: Omit<Parameters<typeof runPriceDropDigest>[1], never>;
  /** Build the idempotency key for a price-drop event (default: the core-assigned `eventId`). */
  readonly digestRunId?: (drop: ProductPriceChangedPayload) => string;
}

/**
 * Idempotency key for a price-drop event: the core-assigned, unique-per-emit `eventId`. Keying on
 * `eventId` (NOT the {old,new} value tuple) means two genuinely distinct drops of the same magnitude
 * — a flash-sale cycle 100→70 … 70→100 … 100→70 — each fire, while reprocessing the SAME event stays
 * deduped by the digest's UNIQUE ledger.
 */
function defaultDigestRunId(drop: ProductPriceChangedPayload): string {
  return `price_changed:${drop.eventId}`;
}

/**
 * Register the module's event handlers. Call once during `activate`.
 *
 * When `priceDrop` deps are supplied, the module subscribes to `product.price_changed` and runs the
 * idempotent digest on a real drop. `onProductUpdated` / `onPriceDropDigest` hooks are exposed so
 * unit tests can observe the handlers directly.
 */
export async function registerSubscriptions(
  events: EventsClient,
  hooks: {
    onProductUpdated?: (productId: string) => void;
    priceDrop?: PriceDropDeps;
    onPriceDropDigest?: (result: DigestResult) => void;
  } = {},
): Promise<void> {
  await events.on('product.updated', (payload) => {
    const productId = readProductId(payload);
    if (!productId) return;
    // Best-effort signal only — the live price path is product.price_changed below.
    hooks.onProductUpdated?.(productId);
  });

  const priceDrop = hooks.priceDrop;
  if (priceDrop) {
    const run = priceDrop.runDigest ?? runPriceDropDigest;
    const runId = priceDrop.digestRunId ?? defaultDigestRunId;
    await events.on('product.price_changed', async (payload) => {
      const drop = readPriceDrop(payload);
      if (!drop) return; // malformed or not a drop → nothing to do (idempotent no-op)
      const candidate: PriceDropCandidate = {
        productVariantId: drop.variantId,
        title: 'an item on your wishlist',
        oldPriceMinor: drop.oldPriceMinor,
        newPriceMinor: drop.newPriceMinor,
        currency: drop.currency,
      };
      const result = await run(
        { digestRunId: runId(drop), candidates: [candidate] },
        priceDrop.digest,
      );
      hooks.onPriceDropDigest?.(result);
    });
  }
}
