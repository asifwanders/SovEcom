/**
 * Search-args builder — the SINGLE deterministic mapping from a request's
 * route `params` + parsed `searchParams` to the `fetchSearch` argument object, shared by EVERY
 * results-consuming section loader on the category + search surfaces (header count, product grid,
 * pagination total, filter sidebar facets).
 *
 * Why one builder, `cache()`-memoised on PRIMITIVES: React `cache()` keys on argument identity
 * (`Object.is`), so `fetchSearch` only dedups when callers pass the SAME args object reference.
 * `searchArgsFrom` is `cache()`-wrapped on its primitive inputs (the parsed query fields + the
 * optional category slug), so for a given request it returns a STABLE object reference — every
 * section loader that calls it gets the identical reference and therefore a `fetchSearch` cache hit
 * (one round-trip per render pass). The parse rules (sort allowlist, page clamp, price minor-units)
 * are VERBATIM from the pre-refactor category/search pages, so parity is preserved.
 */
import { cache } from 'react';
import type { SearchArgs } from '@/lib/catalog';

/** The page-size both PLPs use (24, matching the pre-refactor category + search pages). */
export const PAGE_SIZE = 24;

const SORTS = ['relevance', 'price_asc', 'price_desc', 'newest'] as const;
export type Sort = (typeof SORTS)[number];

/** Parse `?sort=` against the allowlist; anything else → `relevance` (verbatim from the pages). */
export function parseSort(raw: string | undefined): Sort {
  return SORTS.includes(raw as Sort) ? (raw as Sort) : 'relevance';
}

/** Parse `?page=` → an integer >= 1; garbage / out-of-range low values clamp to 1 (verbatim). */
export function parsePage(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Parse a price param (`?minPrice=`/`?maxPrice=`) → a non-negative integer in MINOR units (cents),
 * or `undefined` for blank/garbage/negative input (so the filter is OMITTED). Verbatim from the
 * pages — the URL already carries minor units (FilterSidebar wrote them via `majorToMinor`).
 */
export function parsePriceMinor(raw: string | undefined): number | undefined {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The parsed, normalised query fields a results surface reads — derived once from the raw
 * `searchParams` so the loaders + the parity helpers (pagination/header/sort `preserve`) all agree.
 */
export interface ParsedQuery {
  q: string;
  sort: Sort;
  page: number;
  category: string | undefined;
  minPrice: number | undefined;
  maxPrice: number | undefined;
  currency: string | undefined;
}

/** Parse the raw `searchParams` record into the normalised query fields (verbatim page semantics). */
export function parseQuery(searchParams: Record<string, string> | undefined): ParsedQuery {
  const sp = searchParams ?? {};
  return {
    q: (sp.q ?? '').trim(),
    sort: parseSort(sp.sort),
    page: parsePage(sp.page),
    category: sp.category || undefined,
    minPrice: parsePriceMinor(sp.minPrice),
    maxPrice: parsePriceMinor(sp.maxPrice),
    currency: sp.currency || undefined,
  };
}

/**
 * Build the STABLE `fetchSearch` args object for a request. `cache()`-memoised on the primitive
 * inputs (passed positionally so identity-equal primitives hit the cache), so repeated calls within
 * one render pass return the SAME reference → `fetchSearch` dedups to one round-trip. `kind`
 * distinguishes the two surfaces: `category` fixes the category via the route slug (and never sends
 * `q`); `search` sends `q` + the optional `category` facet. Mirrors the pre-refactor page fetch args.
 */
const buildArgs = cache(
  (
    kind: 'category' | 'search',
    slug: string | undefined,
    q: string,
    sort: Sort,
    page: number,
    category: string | undefined,
    minPrice: number | undefined,
    maxPrice: number | undefined,
    currency: string | undefined,
  ): SearchArgs => {
    const args: SearchArgs = { sort, page, pageSize: PAGE_SIZE };
    if (kind === 'category') {
      if (slug) args.category = slug;
    } else {
      args.q = q;
      if (category) args.category = category;
    }
    if (minPrice !== undefined) args.minPrice = minPrice;
    if (maxPrice !== undefined) args.maxPrice = maxPrice;
    if (currency) args.currency = currency;
    return args;
  },
);

/**
 * Produce the stable `fetchSearch` args for the CATEGORY surface (the route slug fixes the category).
 * Returns the same reference for the same `(slug, query)` within a render pass (see {@link buildArgs}).
 */
export function categorySearchArgs(slug: string, query: ParsedQuery): SearchArgs {
  return buildArgs(
    'category',
    slug,
    query.q,
    query.sort,
    query.page,
    query.category,
    query.minPrice,
    query.maxPrice,
    query.currency,
  );
}

/** Produce the stable `fetchSearch` args for the SEARCH surface (`q` + the selectable category facet). */
export function searchSearchArgs(query: ParsedQuery): SearchArgs {
  return buildArgs(
    'search',
    undefined,
    query.q,
    query.sort,
    query.page,
    query.category,
    query.minPrice,
    query.maxPrice,
    query.currency,
  );
}

/** The `/products` PLP page-size (24, matching the pre-refactor products page). */
export const PRODUCTS_PAGE_SIZE = 24;

/**
 * Build the STABLE `fetchProducts` args for the `/products` PLP, `cache()`-memoised on the cursor so
 * the `product-grid` + `products-load-more` loaders pass the SAME reference → one round-trip per pass.
 */
const buildProductListArgs = cache(
  (cursor: string | undefined): { pageSize: number; cursor?: string } => {
    return cursor ? { pageSize: PRODUCTS_PAGE_SIZE, cursor } : { pageSize: PRODUCTS_PAGE_SIZE };
  },
);

/** Produce the stable `fetchProducts` args for the `/products` PLP from the raw `?cursor=` param. */
export function productListArgs(searchParams: Record<string, string> | undefined): {
  pageSize: number;
  cursor?: string;
} {
  return buildProductListArgs(searchParams?.cursor || undefined);
}
