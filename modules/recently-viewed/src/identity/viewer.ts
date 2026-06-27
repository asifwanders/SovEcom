/**
 * recently-viewed — resolving the VIEWER KEY (the per-viewer scoping identity).
 *
 * Two identity paths, mutually exclusive:
 *
 *   1. ACCOUNT (primary): a logged-in shopper. The viewer key is the core-VERIFIED
 *      `req.customer.id` — never read from body/query/headers.
 *
 *   2. GUEST (opt-in): an anonymous shopper. The viewer key is derived from `req.guestId.id`,
 *      the core-VERIFIED guest identity the guard set from a signed, tenant-scoped sov_guest
 *      httpOnly cookie that the API minted. It is NEVER read from client input.
 *
 * A verified customer ALWAYS wins over a supplied guestId. When neither yields a key, there
 * is NO viewer — the handler maps that to 401 on a write and an empty list on a read.
 *
 * KEY NAMESPACE SEPARATION: customer and guest keys are prefixed differently in the shared
 * `viewer_key` column so the two key spaces are disjoint by construction. A guest cannot
 * collide with a customer by having an id that matches a customer's UUID — the prefixes
 * differ.
 */
import type { ModuleHttpRequest } from '@sovecom/module-sdk';

/** Namespace prefixes — customer and guest key spaces are disjoint by construction. */
export const CUSTOMER_KEY_PREFIX = 'cust:';
export const GUEST_KEY_PREFIX = 'guest:';

/** A resolved viewer: an account customer, a storefront guest, or none. */
export type Viewer =
  | { readonly kind: 'customer'; readonly key: string }
  | { readonly kind: 'guest'; readonly key: string }
  | { readonly kind: 'none' };

/**
 * Resolve the viewer for a request. A verified customer ALWAYS wins; otherwise the
 * core-derived guestId is used; otherwise there is no viewer.
 *
 * The returned `key` is NAMESPACE-PREFIXED by kind so customer and guest key spaces are
 * disjoint. Every SQL statement binds this key as `viewer_key`, so per-viewer isolation
 * follows directly from this single resolution point.
 */
export function resolveViewer(req: ModuleHttpRequest): Viewer {
  // 1. Verified customer wins.
  const cid = req.customer?.id;
  if (typeof cid === 'string' && cid.length > 0) {
    return { kind: 'customer', key: CUSTOMER_KEY_PREFIX + cid };
  }
  // 2. Core-derived guest identity (NEVER from client input — set by the guard from a
  //    signed sov_guest cookie).
  const gid = req.guestId?.id;
  if (typeof gid === 'string' && gid.length > 0) {
    return { kind: 'guest', key: GUEST_KEY_PREFIX + gid };
  }
  return { kind: 'none' };
}
