/**
 * notify-back-in-stock — core-event subscriptions (gated by `subscribe:events`).
 *
 * RESTOCK WIRING (follow-up B2 — the gap is now CLOSED): core emits an OBSERVATIONAL
 * `product.stock_changed` event carrying `{ productId, variantId, available }` when a variant's
 * availability FLIPS across zero. The payload is a back-in-stock BOOLEAN ONLY — it never exposes the
 * exact stock level (a competitive-information leak), which is exactly all this notifier needs. On
 * `available === true` (an out-of-stock → in-stock flip) the module runs the existing idempotent
 * {@link runBackInStockNotifications} for that variant's subscribers via `sdk.email.send`.
 *
 * The module still ALSO subscribes to `product.updated` as a lightweight "a product changed" signal
 * (log-only, idempotent) — kept for parity; the stock path is the live one.
 *
 * IDEMPOTENCY: event delivery is at-least-once. The runner reserves each subscription
 * (`markNotified`, NULL → now()) BEFORE sending, so a redelivered stock event re-running the same
 * variant sends nothing further. A malformed payload, or `available === false`, is a no-op.
 */
import type { EventsClient, ProductStockChangedPayload } from '@sovecom/module-sdk';
import { runBackInStockNotifications, type RunResult } from '../notify/notify';

/** Narrow the untrusted event payload to the one field core sends for product.updated. */
function readProductId(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const id = (payload as { productId?: unknown }).productId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

/**
 * Narrow the untrusted `product.stock_changed` payload, or null if malformed. Validates every field
 * — the payload arrives over RPC and is never trusted by shape.
 */
function readStockChange(payload: unknown): ProductStockChangedPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.eventId !== 'string' || p.eventId.length === 0) return null;
  if (typeof p.variantId !== 'string' || p.variantId.length === 0) return null;
  if (typeof p.productId !== 'string') return null;
  if (typeof p.available !== 'boolean') return null;
  // `eventId` is validated for contract-completeness; this notifier's idempotency anchor is the
  // per-subscription `notified_at` reservation (one-shot per subscription), not the eventId.
  return {
    eventId: p.eventId,
    productId: p.productId,
    variantId: p.variantId,
    available: p.available,
  };
}

/**
 * The dependencies the restock handler needs to run the notifier. Injected at `activate` so the
 * handler stays pure/testable. `runNotify` defaults to {@link runBackInStockNotifications}.
 */
export interface RestockDeps {
  readonly runNotify?: typeof runBackInStockNotifications;
  readonly notify: Parameters<typeof runBackInStockNotifications>[1];
}

/**
 * Register the module's event handlers. Call once during `activate`.
 *
 * When `restock` deps are supplied, the module subscribes to `product.stock_changed` and runs the
 * idempotent notifier for the variant when it flips to AVAILABLE. `onProductUpdated` / `onRestock`
 * hooks are exposed so unit tests can observe the handlers directly.
 */
export async function registerSubscriptions(
  events: EventsClient,
  hooks: {
    onProductUpdated?: (productId: string) => void;
    restock?: RestockDeps;
    onRestock?: (result: RunResult) => void;
  } = {},
): Promise<void> {
  await events.on('product.updated', (payload) => {
    const productId = readProductId(payload);
    if (!productId) return;
    // Best-effort signal only — the live restock path is product.stock_changed below.
    hooks.onProductUpdated?.(productId);
  });

  const restock = hooks.restock;
  if (restock) {
    const run = restock.runNotify ?? runBackInStockNotifications;
    await events.on('product.stock_changed', async (payload) => {
      const change = readStockChange(payload);
      if (!change || !change.available) return; // not a back-IN-stock flip → no-op
      const result = await run({ restockedVariantIds: [change.variantId] }, restock.notify);
      hooks.onRestock?.(result);
    });
  }
}
