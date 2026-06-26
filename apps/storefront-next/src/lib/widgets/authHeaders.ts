/**
 * Authorization header builder for personalized slot widgets.
 *
 * The store-module proxy reads the verified customer principal ONLY from a `Authorization: Bearer`
 * token (StoreModuleCustomerAuthGuard) — NOT from a cookie. So a personalized island/widget that wants
 * the module to see `req.customer` (e.g. the wishlist toggle for a logged-in shopper) MUST attach the
 * in-memory access token as a Bearer header. When `getAccessToken()` yields no token (a guest), NO
 * Authorization header is sent → the module sees an anonymous request (wishlist → 204; notify's guest
 * form still works). PURE — no React, no I/O.
 *
 * `token` is the value of the storefront's live `useAuth().getAccessToken()` getter. It lives ONLY in
 * auth-context memory — never localStorage/sessionStorage (XSS posture).
 */

/** A getter returning the live in-memory access token, or null/undefined for a guest. */
export type AccessTokenGetter = () => string | null | undefined;

/**
 * Build the Authorization header(s) for a personalized widget fetch: `{ Authorization: 'Bearer <t>' }`
 * when a token is present, otherwise `{}` (guest → no header). Reads the token at CALL time (so a
 * token that arrives after a silent refresh is used on the next request, never a stale snapshot).
 */
export function bearerAuthHeaders(getAccessToken: AccessTokenGetter): Record<string, string> {
  const token = getAccessToken();
  return typeof token === 'string' && token.length > 0 ? { Authorization: `Bearer ${token}` } : {};
}
