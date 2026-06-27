/**
 * Storefront data layer — adopts `@sovecom/client-js` as the SOLE transport for `/store/v1/*`
 * reads, replacing the ad-hoc `storeFetch`. Usable from React Server
 * Components: a fresh client is constructed per call from `NEXT_PUBLIC_API_BASE_URL`.
 *
 * client-js types params/bodies but NOT response bodies, so each caller supplies its own view-type
 * as the `TResponse` generic. The presentation-only `formatPrice` stays in `lib/api.ts` (a view concern,
 * not transport). In RSC context the httpOnly `sov_cart` cookie must be forwarded onto requests that
 * need it.
 */
import { cookies } from 'next/headers';
import {
  createSovEcomClient,
  type SovEcomClient,
  type SovEcomClientOptions,
} from '@sovecom/client-js';

/** The httpOnly cart cookie set by the API; forwarded from RSC context onto store requests. */
export const CART_COOKIE = 'sov_cart';

/** Default API origin when `NEXT_PUBLIC_API_BASE_URL` is unset — mirrors the old `lib/api.ts`. */
const DEFAULT_API_BASE_URL = 'http://localhost:3000';

/**
 * Resolve the API origin for server-side fetches. Precedence:
 *   1. process.env.API_BASE_URL — runtime env, set per container; wins over the baked build arg.
 *      In compose this is the internal network address (e.g. http://api:3000) for SSR, while the
 *      browser uses the public origin injected via window.__SOVECOM__ from the same env var.
 *   2. process.env.NEXT_PUBLIC_API_BASE_URL — build-time fallback; keeps `next dev` working.
 *   3. DEFAULT_API_BASE_URL (localhost:3000) — local dev with no env at all.
 */
export function getApiBaseUrl(): string {
  return process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL;
}

/**
 * Construct a `@sovecom/client-js` client pointed at the storefront API. `overrides` lets callers
 * (and tests) inject a `fetch`, default `headers` (e.g. a forwarded cookie), or `getToken`.
 */
export function createStoreClient(overrides: Partial<SovEcomClientOptions> = {}): SovEcomClient {
  return createSovEcomClient({
    baseUrl: getApiBaseUrl(),
    ...overrides,
  });
}

/**
 * Read the `sov_cart` cookie from the current RSC request and return a `Cookie` header value that
 * forwards it, or `undefined` when absent. The cookie is httpOnly, so this is the only path that
 * can carry it server-side. Safe to call when no cart cookie exists (returns `undefined`).
 */
export async function getCartCookieHeader(): Promise<string | undefined> {
  const store = await cookies();
  const value = store.get(CART_COOKIE)?.value;
  if (!value) return undefined;
  return `${CART_COOKIE}=${value}`;
}

/**
 * A store client whose requests forward the RSC `sov_cart` cookie (when present). Use for reads
 * that depend on the visitor's cart.
 */
export async function createStoreClientWithCart(): Promise<SovEcomClient> {
  const cookieHeader = await getCartCookieHeader();
  return createStoreClient({
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });
}
