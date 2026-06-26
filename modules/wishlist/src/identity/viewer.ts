/**
 * wishlist -- resolving the VIEWER KIND (the per-viewer identity discriminant).
 *
 * Two identity paths, mutually exclusive:
 *
 *   1. ACCOUNT (primary): a logged-in shopper. The raw customer id comes from the core-VERIFIED
 *      `req.customer.id` -- never read from body/query/headers.
 *
 *   2. GUEST (opt-in): an anonymous shopper. The raw guest id comes from `req.guestId.id`,
 *      the core-VERIFIED guest identity the guard set from a signed, tenant-scoped sov_guest
 *      httpOnly cookie that the API minted. It is NEVER read from client input.
 *
 * A verified customer ALWAYS wins over a supplied guestId. When neither yields an id, there
 * is NO viewer -- the handler maps that to 401 on a write and an empty list on a read.
 *
 * NOTE: wishlist uses separate database tables for customer vs guest rows
 * (`mod_wishlist_items` and `mod_wishlist_guest_items`), so the raw id from
 * `req.customer.id` / `req.guestId.id` is passed directly to repository methods -- no
 * shared `viewer_key` column or namespace prefix is needed here. See handlers.ts for usage.
 */
import type { ModuleHttpRequest } from '@sovecom/module-sdk';

/** A resolved viewer: an account customer, a storefront guest, or none. */
export type Viewer =
  | { readonly kind: 'customer' }
  | { readonly kind: 'guest' }
  | { readonly kind: 'none' };

/**
 * Resolve the viewer kind for a request. A verified customer ALWAYS wins; otherwise the
 * core-derived guestId is used; otherwise there is no viewer.
 *
 * Handlers read the raw id from `req.customer.id` / `req.guestId.id` directly and pass it
 * to the appropriate repository method (customer table vs guest table).
 */
export function resolveViewer(req: ModuleHttpRequest): Viewer {
  // 1. Verified customer wins.
  const cid = req.customer?.id;
  if (typeof cid === 'string' && cid.length > 0) {
    return { kind: 'customer' };
  }
  // 2. Core-derived guest identity (NEVER from client input -- set by the guard from a
  //    signed sov_guest cookie).
  const gid = req.guestId?.id;
  if (typeof gid === 'string' && gid.length > 0) {
    return { kind: 'guest' };
  }
  return { kind: 'none' };
}
