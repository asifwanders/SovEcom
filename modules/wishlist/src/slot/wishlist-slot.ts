/**
 * wishlist -- the slot DATA handler. The module returns a typed widget descriptor `{ type, props }`
 * -- data only, never code or HTML -- over its store mount: `GET /slot?slot=&route=`. The storefront
 * validates it with `parseWidget` and renders its own `toggle-button` (an interactive, personalized
 * client island).
 *
 * PERSONALIZED + VIEWER-SCOPED: identity is resolved via {@link resolveViewer} -- either a
 * core-verified customer (JWT) or a core-derived guest (sov_guest HMAC cookie). An anonymous
 * visitor with no guest identity resolves to 'none' -> 204 (decline).
 *
 * For a logged-in customer, `initialOn` reflects the customer's CURRENT wishlist state.
 * For a guest, `initialOn` reflects the guest's current guest-wishlist state.
 *
 * The `toggle-button` widget POSTs back with no body, so the product id rides in the action
 * path -- the path-based `POST /items/:id/add` and `POST /items/:id/remove` aliases
 * (see api/handlers.ts). Both paths target `/store/v1/modules/wishlist/...` and are
 * additionally pinned to the binding module.
 */
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';
import type { WishlistRepository } from '../db/repository';
import { resolveViewer } from '../identity/viewer';

/** The slot this module fills (must match `sovecom.module.json` slots[].slot). */
export const WISHLIST_SLOT = 'product-card-actions';

/** This module's own store mount -- the only origin its action paths may target. */
const OWN_MOUNT = '/store/v1/modules/wishlist';

/** First value for a query key (the query may carry repeated keys -> string[]). */
function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Forbidden bytes in the route product id: control chars (C0 + DEL) or a path separator (`/`, `\`).
 * The route id becomes a path SEGMENT in the emitted action paths, so reject anything that could
 * smuggle a separator/control byte.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_ROUTE_CHARS = /[\x00-\x1f\x7f/\\]/;

/** A bound product-id route value (trimmed, 1-64 chars, no control/separator chars). */
function readRouteProductId(req: ModuleHttpRequest): string | undefined {
  const value = firstQuery(req.query.route);
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return undefined;
  if (FORBIDDEN_ROUTE_CHARS.test(v)) return undefined;
  return v;
}

/** A bodyless 204 -- the module declines to render at this slot. */
function decline(): ModuleHttpResponse {
  return { status: 204 };
}

/**
 * Handle `GET /slot`. Returns the `toggle-button` descriptor for the route's product scoped to
 * the resolved viewer (customer or guest), or 204 (no viewer / unknown slot / invalid route).
 */
export async function handleWishlistSlot(
  req: ModuleHttpRequest,
  repo: WishlistRepository,
): Promise<ModuleHttpResponse> {
  if (firstQuery(req.query.slot) !== WISHLIST_SLOT) return decline();

  const productId = readRouteProductId(req);
  if (!productId) return decline();

  const viewer = resolveViewer(req);
  // Decline for truly anonymous requests (no customer JWT and no guest cookie).
  if (viewer.kind === 'none') return decline();

  let initialOn: boolean;
  if (viewer.kind === 'customer') {
    initialOn = await repo.has(req.customer!.id, productId);
  } else {
    // viewer.kind === 'guest'
    initialOn = await repo.guestHas(req.guestId!.id, productId);
  }

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
