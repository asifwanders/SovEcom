/**
 * recently-viewed — resolving the VIEWER KEY (the per-viewer scoping identity).
 *
 * Two honest, non-overlapping identity paths:
 *
 *   1. ACCOUNT (primary, fully supported): a logged-in shopper. The viewer key is the core-VERIFIED
 *      `req.customer.id` (the 3.10-i.5 bridge) — never read from the body/query/headers. This is the
 *      secure, per-customer path and the one the integration suite exercises end-to-end.
 *
 *   2. GUEST (opt-in, storefront-managed): an anonymous shopper. The sandboxed module does NOT — and
 *      must not — manage storefront cookies. So instead of inventing an insecure scheme, the module
 *      accepts an OPAQUE guest token the STOREFRONT supplies (header `x-rv-guest` or `?guest=`). The
 *      token IS the viewer key. Recently-viewed history is low-sensitivity (not PII), but the module
 *      still must never let one guest read another's by a guessable id — so it requires the token to
 *      be HIGH-ENTROPY (see {@link MIN_GUEST_TOKEN_LEN}); a short/empty token is rejected, NOT
 *      silently shared. Minting + storing that high-entropy cookie is the storefront's job, deferred
 *      to the 3.20 storefront integration (see README "Guest identity").
 *
 * A verified customer ALWAYS wins over any supplied guest token (you can't impersonate by sending a
 * guest token while logged in). When neither yields a usable key, there is NO viewer → the handler
 * maps that to 401 on a write and an empty list on a read.
 */
import type { ModuleHttpRequest } from '@sovecom/module-sdk';

/**
 * Minimum length of an accepted guest token. The storefront is documented to mint a high-entropy
 * opaque token (e.g. a 128-bit random value, ~22+ base64url chars); we reject anything shorter so a
 * trivially-guessable value (e.g. "1", "guest") can never be used to read another viewer's history.
 * This is a floor, not entropy verification — the storefront owns minting (README "Guest identity").
 */
export const MIN_GUEST_TOKEN_LEN = 16;
/** Upper bound so a pathological token can't bloat the bound `viewer_key` column / index. */
export const MAX_GUEST_TOKEN_LEN = 200;

/** A resolved viewer: an account customer, a storefront guest, or none. */
export type Viewer =
  | { readonly kind: 'customer'; readonly key: string }
  | { readonly kind: 'guest'; readonly key: string }
  | { readonly kind: 'none' };

/**
 * Key-namespace prefixes that DISCRIMINATE a customer key from a guest key in the shared
 * `viewer_key` column. Without these a guest could supply `?guest=<a known customer's id>` (≥16
 * chars → accepted) and COLLIDE with that customer's key, reading + polluting their history. The
 * prefixes make the two key spaces disjoint by construction: `'cust:' + id` can never equal
 * `'guest:' + token`, so a guest token — whatever string it is — can never address a customer.
 */
export const CUSTOMER_KEY_PREFIX = 'cust:';
export const GUEST_KEY_PREFIX = 'guest:';

/**
 * Forbidden control characters in an identity input (C0 range + DEL). A NUL/control char in a guest
 * token would otherwise reach a bound SQL param and PostgreSQL rejects an embedded NUL — surfacing
 * as an unhandled error. Reject it here so a bad token simply yields "no guest" (a clean path),
 * never a 500. Written with hex escapes only — no raw control bytes in source.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\x00-\x1f\x7f]/;

/** The core-verified customer id, or null when the caller is anonymous. */
function customerId(req: ModuleHttpRequest): string | null {
  const id = req.customer?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** First value for a (possibly repeated) query key. */
function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Extract a usable guest token from the `x-rv-guest` header (preferred) or the `?guest=` query.
 * Returns the trimmed token only when it meets the length floor AND carries no control characters; a
 * missing / empty / too-short / over-long / control-char-bearing token yields undefined (→ no guest
 * identity). Core sanitizes headers and strips auth/cookie, but a plain custom header like
 * `x-rv-guest` survives; the query param is the always-available fallback channel.
 */
function guestToken(req: ModuleHttpRequest): string | undefined {
  const raw = req.headers['x-rv-guest'] ?? firstQuery(req.query.guest);
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  if (v.length < MIN_GUEST_TOKEN_LEN || v.length > MAX_GUEST_TOKEN_LEN) return undefined;
  if (FORBIDDEN_CONTROL.test(v)) return undefined;
  return v;
}

/**
 * Resolve the viewer for a request. A verified customer ALWAYS wins; otherwise a valid storefront
 * guest token is used; otherwise there is no viewer. The returned `key` is NAMESPACE-PREFIXED by
 * kind (so the customer and guest key spaces are disjoint — see CUSTOMER_KEY_PREFIX) and is what
 * every SQL statement binds as `viewer_key`, so per-viewer isolation follows directly from this
 * single resolution point.
 */
export function resolveViewer(req: ModuleHttpRequest): Viewer {
  const cid = customerId(req);
  if (cid) return { kind: 'customer', key: CUSTOMER_KEY_PREFIX + cid };
  const token = guestToken(req);
  if (token) return { kind: 'guest', key: GUEST_KEY_PREFIX + token };
  return { kind: 'none' };
}
