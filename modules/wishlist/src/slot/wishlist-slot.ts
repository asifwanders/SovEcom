/**
 * wishlist — the slot DATA handler. The module returns a typed widget descriptor `{ type, props }`
 * — data only, never code or HTML — over its store mount: `GET /slot?slot=&route=`. The storefront
 * validates it with `parseWidget` and renders its own `toggle-button` (an interactive, personalized
 * client island).
 *
 * PERSONALIZED + CUSTOMER-SCOPED: identity is read ONLY from the core-verified `req.customer.id` (never
 * client input). A wishlist needs an account, so an ANONYMOUS visitor ⇒ 204 (decline — the island
 * renders nothing). For a signed-in customer the descriptor's `initialOn` is the customer's CURRENT
 * wishlist state for the route's product, and the on/off action paths target THIS module's OWN mount.
 *
 * The `toggle-button` widget POSTs back with no body, so the product id rides in the action path — the
 * path-based `POST /items/:id/add` and `POST /items/:id/remove` aliases (see api/handlers.ts). Both
 * paths target `/store/v1/modules/wishlist/...` and are additionally pinned to the binding module.
 */
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';
import type { WishlistRepository } from '../db/repository';

/** The slot this module fills (must match `sovecom.module.json` slots[].slot). */
export const WISHLIST_SLOT = 'product-card-actions';

/** This module's own store mount — the only origin its action paths may target. */
const OWN_MOUNT = '/store/v1/modules/wishlist';

/** First value for a query key (the query may carry repeated keys → string[]). */
function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Forbidden bytes in the route product id: control chars (C0 + DEL) or a path separator (`/`, `\`).
 * The route id becomes a path SEGMENT in the emitted action paths, so reject anything that could smuggle
 * a separator/control byte (defense-in-depth; C1's actionPathSchema would also reject the resulting path).
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_ROUTE_CHARS = /[\x00-\x1f\x7f/\\]/;

/** A bound product-id route value (trimmed, 1–64 chars, no control/separator chars). */
function readRouteProductId(req: ModuleHttpRequest): string | undefined {
  const value = firstQuery(req.query.route);
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return undefined;
  if (FORBIDDEN_ROUTE_CHARS.test(v)) return undefined;
  return v;
}

/** The verified customer id, or null when anonymous. */
function customerIdOrNull(req: ModuleHttpRequest): string | null {
  const id = req.customer?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** A bodyless 204 — the module declines to render at this slot. */
function decline(): ModuleHttpResponse {
  return { status: 204 };
}

/**
 * Handle `GET /slot`. Returns the `toggle-button` descriptor for the route's product scoped to the
 * verified customer, or 204 (anonymous / unknown slot / invalid route).
 */
export async function handleWishlistSlot(
  req: ModuleHttpRequest,
  repo: WishlistRepository,
): Promise<ModuleHttpResponse> {
  if (firstQuery(req.query.slot) !== WISHLIST_SLOT) return decline();

  const productId = readRouteProductId(req);
  if (!productId) return decline();

  // A wishlist needs an account — an anonymous visitor declines (the island renders nothing).
  const customerId = customerIdOrNull(req);
  if (!customerId) return decline();

  const initialOn = await repo.has(customerId, productId);

  // The product id rides in the PATH (the toggle posts no body). encodeURIComponent keeps it a single
  // inert segment under the own mount. This is DEFENSE-IN-DEPTH and intentionally redundant: `readId`
  // (the route reader) already rejects an id with `/`, `\`, or a control char, and C1's actionPathSchema
  // bans `%` outright (a clean id never needs encoding) — but encoding here means even if those layers
  // ever changed, a reserved char could not break out of the single path segment. C2 then re-pins the
  // path to this binding module (own-mount).
  const seg = encodeURIComponent(productId);
  const descriptor = {
    type: 'toggle-button' as const,
    props: {
      initialOn,
      onAction: { path: `${OWN_MOUNT}/items/${seg}/add` },
      offAction: { path: `${OWN_MOUNT}/items/${seg}/remove` },
      labels: { on: 'In your wishlist', off: 'Add to wishlist' },
      icon: 'heart' as const,
    },
  };
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(descriptor),
  };
}
