/**
 * Browser-safe instant-search fetch. The `SearchBar` typeahead runs in a CLIENT component, so it
 * CANNOT import `lib/store-client.ts` / `lib/catalog.ts` — those pull in `next/headers` at module
 * scope (the RSC cart-cookie forwarding helper), which throws in the browser bundle. So this module
 * constructs the dependency-free `@sovecom/client-js` client DIRECTLY from `NEXT_PUBLIC_API_BASE_URL`
 * (a public env, inlined into the client bundle) and issues a plain browser `fetch` against the
 * EXISTING public `/store/v1/search` endpoint (no API change, no cookies — public search needs none).
 * client-js types params but NOT responses, so this module owns its raw→view mapping, mirroring
 * `lib/catalog.ts` `toCardFromHit` (kept self-contained here to avoid importing the
 * `next/headers`-tainted module). Type-only imports from `catalog` are erased.
 *
 * NO tracking/analytics, NO query logging (Plausible only). The endpoint is rate-limited (120/min/IP),
 * so the caller debounces + enforces a min query length before invoking this.
 */
import { createSovEcomClient } from '@sovecom/client-js';
import type { ProductCardView, SearchResultView } from './catalog';

/** Default API origin when `NEXT_PUBLIC_API_BASE_URL` is unset — mirrors `lib/store-client.ts`. */
const DEFAULT_API_BASE_URL = 'http://localhost:3000';

/** How many typeahead hits the dropdown shows — small, to stay rate-limit-friendly. */
export const INSTANT_SEARCH_PAGE_SIZE = 6;

/** Raw search hit (the allowlisted store DTO subset the dropdown renders). Mirrors `lib/catalog`. */
interface RawSearchHit {
  id: string;
  slug: string;
  title: string;
  thumbnailUrl?: string | null;
  priceAmount?: number | null;
  currency?: string | null;
}

interface RawSearchResult {
  hits?: RawSearchHit[];
  total?: number;
}

function toCard(h: RawSearchHit): ProductCardView {
  return {
    id: h.id,
    slug: h.slug,
    title: h.title,
    thumbnailUrl: h.thumbnailUrl ?? null,
    priceAmount: h.priceAmount ?? null,
    currency: h.currency ?? null,
  };
}

/** Resolve the API origin from the PUBLIC env (inlined into the client bundle), falling back to localhost. */
function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE_URL;
}

/**
 * Browser-side instant-search against the public `/store/v1/search`. Returns the mapped product
 * cards + total. The `signal` cancels the in-flight request when the caller debounces a new keystroke
 * (the caller is responsible for ignoring an AbortError — this helper does NOT swallow it, so an abort
 * is distinguishable from a real failure). `facets` are not used by the typeahead, so an empty facets
 * shape is returned to satisfy the shared `SearchResultView`.
 */
export async function searchInstant(q: string, signal: AbortSignal): Promise<SearchResultView> {
  const client = createSovEcomClient({ baseUrl: apiBaseUrl() });
  const res = await client.request<'/store/v1/search', 'get', RawSearchResult>(
    'get',
    '/store/v1/search',
    { query: { q, pageSize: INSTANT_SEARCH_PAGE_SIZE }, signal },
  );
  return {
    products: (res.hits ?? []).map(toCard),
    facets: { categories: [], price: null },
    total: res.total ?? 0,
  };
}
