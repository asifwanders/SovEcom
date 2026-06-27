/**
 * Browser-safe `@sovecom/client-js` factory for the transactional storefront.
 *
 * Mirrors `lib/search-client.ts`: a CLIENT-only module that constructs the dependency-free client-js
 * DIRECTLY from `NEXT_PUBLIC_API_BASE_URL` (a public env inlined into the browser bundle). It MUST
 * NEVER import `next/headers` — that taint is the SERVER-only `store-client.ts`'s job; importing it
 * here would throw in the browser bundle.
 *
 * Two seams the cart/auth contexts wire in:
 *   1. a custom `fetch` that forces `credentials:'include'` on EVERY request, so the httpOnly
 *      `sov_cart` cart cookie AND the httpOnly customer refresh cookie ride along cross-origin
 *      (storefront origin → API origin). client-js's own `doFetch` sends no credentials by design;
 * this is the storefront-side closure of that gap with NO client-js change.
 *   2. the in-memory customer access token, injected as a Bearer via client-js's `getToken` hook.
 *      `getAccessToken` is a LIVE getter (read per request), so a token that arrives after a silent
 *      refresh is picked up on the very next call — never a stale snapshot. The token lives ONLY in
 *      the auth-context's memory (never localStorage/sessionStorage — XSS posture).
 *
 * client-js types params/bodies but NOT responses → every caller in the storefront
 * owns its own response view-type as the `TResponse` generic (see `cart-context.tsx`).
 */
import { createSovEcomClient, type SovEcomClient } from '@sovecom/client-js';

/** Default API origin when `NEXT_PUBLIC_API_BASE_URL` is unset — mirrors `lib/store-client.ts`. */
const DEFAULT_API_BASE_URL = 'http://localhost:3000';

/**
 * Resolve the API origin at runtime. Precedence:
 *   1. window.__SOVECOM__.apiBaseUrl  — injected by the locale layout server component from
 *      process.env.API_BASE_URL at request time; makes one Docker image work on any domain.
 *   2. process.env.NEXT_PUBLIC_API_BASE_URL — build-time fallback; keeps `next dev` working
 *      without a runtime env.
 *   3. DEFAULT_API_BASE_URL (localhost:3000) — local dev with no env at all.
 *
 * Exported so client components that issue raw credentialed `fetch` calls reuse the same
 * browser-safe origin resolution instead of hardcoding the base URL.
 */
export function apiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const runtimeUrl = window.__SOVECOM__?.apiBaseUrl;
    if (runtimeUrl && runtimeUrl !== '__API_BASE_URL__') return runtimeUrl;
  }
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL;
}

export interface BrowserClientOptions {
  /**
   * Live getter for the in-memory customer access token. Returns `null`/`undefined` for a guest or
   * before the first silent refresh. Read on EVERY request so a freshly-refreshed token is used
   * immediately. The auth-context owns this seam; guest/cart flows simply omit it.
   */
  getAccessToken?: () => string | null | undefined;
  /** Override `fetch` (tests / non-browser). Defaults to the global browser `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Build a browser `@sovecom/client-js` instance whose every request carries `credentials:'include'`
 * and (when present) the in-memory Bearer token. Safe to construct per-render or memoize; it holds
 * no mutable state of its own — the token is always re-read through `getAccessToken`.
 */
export function createBrowserClient(options: BrowserClientOptions = {}): SovEcomClient {
  const baseFetch = options.fetch ?? globalThis.fetch;
  // Force credentialed requests. We DON'T mutate the caller's `RequestInit` — spread a fresh object
  // so client-js's `Headers`/`signal`/`body` are preserved and only `credentials` is (re)set.
  const credentialedFetch: typeof fetch = (input, init) =>
    baseFetch(input, { ...init, credentials: 'include' });

  return createSovEcomClient({
    baseUrl: apiBaseUrl(),
    fetch: credentialedFetch,
    // client-js only sets Authorization when the caller didn't already supply one, and skips it when
    // this returns a falsy value — exactly the guest/none behaviour we want.
    getToken: options.getAccessToken ? () => options.getAccessToken!() ?? undefined : undefined,
  });
}
