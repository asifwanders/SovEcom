/**
 * Catalog read data-layer — the storefront's view-types + fetch helpers for the public `/store/v1/*`
 * catalog reads. client-js is the sole transport and types params but NOT responses, so this module
 * OWNS the response view-types it renders, mirroring the API's store DTO allowlists exactly.
 *
 * Every fetch is wrapped so a cold/unreachable API (ECONNREFUSED) or any transport error degrades
 * to a graceful empty result rather than crashing the RSC render / ISR build. The ONE exception is
 * a category slug 404 (`SovEcomApiError` status 404), which the category page must surface as a
 * Next `notFound()` — so `fetchCategoryBySlug` distinguishes "not found" (null) from "unreachable"
 * by re-reading the error status.
 */
import { cache } from 'react';
import { createStoreClient } from './store-client';
import { SovEcomApiError } from '@sovecom/client-js';

/** A single product card as rendered on listing surfaces. Mirrors the store product/search DTOs. */
export interface ProductCardView {
  id: string;
  slug: string;
  title: string;
  /** Public thumbnail URL, or null when the product has no image. */
  thumbnailUrl: string | null;
  /** Lowest variant price in integer minor units (cents), or null when unpriced. */
  priceAmount: number | null;
  /** ISO-4217 currency of `priceAmount`, or null when unpriced. */
  currency: string | null;
}

/** A page of product cards plus the opaque cursor for the next page (null = last page). */
export interface ProductListView {
  products: ProductCardView[];
  nextCursor: string | null;
}

/** A category as rendered (index + PLP header). Mirrors `StoreCategoryDto`. */
export interface CategoryView {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  children: CategoryView[];
}

/** A category facet as rendered in the `FilterSidebar` (slug + name + hit-count). Mirrors `CategoryFacet`. */
export interface CategoryFacetView {
  slug: string;
  name: string;
  count: number;
}

/** Price facet stats in integer minor units (cents). Mirrors `PriceFacetStats`. */
export interface PriceFacetView {
  min: number;
  max: number;
}

/**
 * The facets the search API returns alongside hits. Widens the storefront's search view-type to
 * carry the category + price facets `FilterSidebar` renders. The storefront owns this response view-type.
 * `price` is null when there are no priced hits.
 */
export interface SearchFacetsView {
  categories: CategoryFacetView[];
  price: PriceFacetView | null;
}

/** Search results view — product cards + facets + total. Mirrors `SearchResultDto` (subset rendered). */
export interface SearchResultView {
  products: ProductCardView[];
  facets: SearchFacetsView;
  total: number;
}

/** A single variant as rendered on the PDP (display-only — no add-to-cart). Mirrors `StoreVariantDto`. */
export interface ProductVariantView {
  id: string;
  /** Variant title (e.g. "Large / Red"), or null when unnamed. */
  title: string | null;
  /** Display-safe variant options (e.g. { size: 'M' }); stringified at render. */
  options: Record<string, unknown>;
  /** Price in integer minor units (cents). */
  priceAmount: number;
  /** ISO-4217 currency of `priceAmount`. */
  currency: string;
  /** Coarse availability (stock > 0 OR backorder allowed). */
  availability: boolean;
}

/** A single product image as rendered on the PDP gallery. Mirrors `StoreImageDto`. */
export interface ProductImageView {
  /** Public thumbnail URL. May be empty when the image has no rendered thumbnail variant. */
  thumbnailUrl: string;
  /** Alt text, or null. */
  altText: string | null;
}

/** Full product detail as rendered on the PDP. Mirrors the store product DTO (allowlisted subset). */
export interface ProductDetailView {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  variants: ProductVariantView[];
  images: ProductImageView[];
}

// --- Raw API response shapes (the allowlisted store DTOs we render against) -------------------

interface RawVariant {
  priceAmount: number;
  currency: string;
}

interface RawImage {
  thumbnailUrl: string;
}

interface RawStoreProduct {
  id: string;
  slug: string;
  title: string;
  variants?: RawVariant[];
  images?: RawImage[];
}

interface RawProductList {
  data: RawStoreProduct[];
  nextCursor: string | null;
}

/** Full single-product DTO (allowlisted store shape) — the PDP renders against this. */
interface RawProductDetailVariant {
  id: string;
  title: string | null;
  options?: Record<string, unknown>;
  priceAmount: number;
  currency: string;
  availability: boolean;
}

interface RawProductDetailImage {
  thumbnailUrl: string;
  altText: string | null;
}

interface RawProductDetail {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  variants?: RawProductDetailVariant[];
  images?: RawProductDetailImage[];
}

interface RawCategory {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  children?: RawCategory[];
}

interface RawCategoryList {
  data: RawCategory[];
}

interface RawSearchHit {
  id: string;
  slug: string;
  title: string;
  thumbnailUrl?: string | null;
  priceAmount?: number | null;
  currency?: string | null;
}

interface RawCategoryFacet {
  slug: string;
  name: string;
  count: number;
}

interface RawPriceFacet {
  min: number;
  max: number;
}

interface RawSearchFacets {
  categories?: RawCategoryFacet[];
  price?: RawPriceFacet | null;
}

interface RawSearchResult {
  hits: RawSearchHit[];
  facets?: RawSearchFacets;
  total: number;
}

// --- Mappers (raw allowlisted DTO → view-type) ------------------------------------------------

/** Lowest-priced variant of a store product, or undefined when it has no variants. */
function lowestVariant(variants: RawVariant[] | undefined): RawVariant | undefined {
  if (!variants || variants.length === 0) return undefined;
  return variants.reduce((min, v) => (v.priceAmount < min.priceAmount ? v : min));
}

function toCardFromProduct(p: RawStoreProduct): ProductCardView {
  const variant = lowestVariant(p.variants);
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    thumbnailUrl: p.images?.[0]?.thumbnailUrl ?? null,
    priceAmount: variant?.priceAmount ?? null,
    currency: variant?.currency ?? null,
  };
}

function toCardFromHit(h: RawSearchHit): ProductCardView {
  return {
    id: h.id,
    slug: h.slug,
    title: h.title,
    thumbnailUrl: h.thumbnailUrl ?? null,
    priceAmount: h.priceAmount ?? null,
    currency: h.currency ?? null,
  };
}

/**
 * Map the raw search facets to the view-type, defensively. The API always returns
 * `facets`, but a cold/partial response (or a future shape change) must NOT crash the render: an
 * absent/partial `facets` defaults to empty categories + null price. Category facets missing a count
 * default to 0; a malformed price (non-finite min/max) drops to null. Mirrors the rest of the
 * catalog's graceful posture.
 */
function toFacetsView(facets: RawSearchFacets | undefined): SearchFacetsView {
  const categories = (facets?.categories ?? [])
    .filter((c): c is RawCategoryFacet => !!c && typeof c.slug === 'string')
    .map((c) => ({ slug: c.slug, name: c.name ?? c.slug, count: Number(c.count) || 0 }));
  const rawPrice = facets?.price;
  const price =
    rawPrice && Number.isFinite(rawPrice.min) && Number.isFinite(rawPrice.max)
      ? { min: rawPrice.min, max: rawPrice.max }
      : null;
  return { categories, price };
}

function toCategoryView(c: RawCategory): CategoryView {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    parentId: c.parentId,
    children: (c.children ?? []).map(toCategoryView),
  };
}

// --- Fetch helpers (graceful degradation on transport error) ----------------------------------

const EMPTY_LIST: ProductListView = { products: [], nextCursor: null };

/**
 * List published products (cursor pagination). Returns an empty page on any transport error so the
 * home/PLP surfaces and the ISR build never crash on a cold API.
 *
 * Wrapped in React `cache` so the `/products` PLP's `product-grid` + `products-load-more`
 * loaders share ONE `/store/v1/products` round-trip per render pass — PROVIDED they pass the SAME args
 * reference. `cache()` keys on argument identity, so dedup-needing callers build args via
 * {@link productListArgs} (a `cache()`-memoised stable reference); the `featured-products` home loader
 * passes its own `{ pageSize }` (a distinct key), so home is unaffected. Empty-on-error preserved.
 */
export const fetchProducts = cache(
  async (opts: { pageSize?: number; cursor?: string }): Promise<ProductListView> => {
    try {
      const client = createStoreClient();
      const query: { pageSize?: number; cursor?: string } = {};
      if (opts.pageSize !== undefined) query.pageSize = opts.pageSize;
      if (opts.cursor) query.cursor = opts.cursor;
      const res = await client.request<'/store/v1/products', 'get', RawProductList>(
        'get',
        '/store/v1/products',
        { query },
      );
      return {
        products: (res.data ?? []).map(toCardFromProduct),
        nextCursor: res.nextCursor ?? null,
      };
    } catch {
      return EMPTY_LIST;
    }
  },
);

/** The category tree (nested). Returns `[]` on any transport error. */
export async function fetchCategoryTree(): Promise<CategoryView[]> {
  try {
    const client = createStoreClient();
    const res = await client.request<'/store/v1/categories/tree', 'get', RawCategoryList>(
      'get',
      '/store/v1/categories/tree',
    );
    return (res.data ?? []).map(toCategoryView);
  } catch {
    return [];
  }
}

/**
 * Fetch a category by slug. Returns `null` when the slug does not exist (API 404) — the caller maps
 * that to `notFound()`. A transport/unreachable error also returns `null` (the page 404s rather than
 * 500s on a cold API, consistent with the rest of the catalog's graceful degradation).
 *
 * Wrapped in React `cache` so the category PLP's
 * `notFound` guard, `generateMetadata`, and the `category-header-row` section loader share ONE
 * `/store/v1/categories/{slug}` round-trip per render pass. client-js bypasses Next's native fetch
 * dedup, so `cache()` restores single-request parity; the memoised RESOLVED value preserves the
 * null-return (404 / cold-API) behavior unchanged.
 */
export const fetchCategoryBySlug = cache(async (slug: string): Promise<CategoryView | null> => {
  try {
    const client = createStoreClient();
    const res = await client.request<'/store/v1/categories/{slug}', 'get', RawCategory>(
      'get',
      '/store/v1/categories/{slug}',
      { path: { slug } },
    );
    return toCategoryView(res);
  } catch (err) {
    if (err instanceof SovEcomApiError && err.status === 404) return null;
    return null;
  }
});

/**
 * Search products (Meilisearch-backed). Used both for the `/search` page and to list a category's
 * products on the PLP (the products list endpoint has no category filter, but search supports a
 * `category` slug filter). Returns an empty result on any transport error.
 */
const EMPTY_FACETS: SearchFacetsView = { categories: [], price: null };

/** The argument shape `fetchSearch` accepts (also the stable key `searchArgsFrom` produces). */
export interface SearchArgs {
  q?: string;
  category?: string;
  tag?: string;
  /** Minimum price in integer minor units (cents). */
  minPrice?: number;
  /** Maximum price in integer minor units (cents). */
  maxPrice?: number;
  /** ISO-4217 currency to scope a price filter to (the API constrains price math to one currency). */
  currency?: string;
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'newest';
  page?: number;
  pageSize?: number;
}

/**
 * Search products (Meilisearch-backed). Wrapped in React `cache` so the section
 * loaders that all read the same result set (header count, product grid, pagination total, filter
 * facets) share ONE `/store/v1/search` round-trip per render pass — PROVIDED they pass the SAME args
 * object reference. `cache()` keys on argument identity (`Object.is`), so callers MUST build their
 * args via {@link searchArgsFrom} (itself `cache()`-memoised on the primitive inputs), which returns
 * a stable reference for a given `(slug, searchParams)` — so every loader gets a cache hit. Returns
 * an empty result on any transport error (graceful degradation preserved, memoised per the args).
 */
export const fetchSearch = cache(async (opts: SearchArgs): Promise<SearchResultView> => {
  try {
    const client = createStoreClient();
    const query: Record<string, unknown> = {};
    if (opts.q) query.q = opts.q;
    if (opts.category) query.category = opts.category;
    if (opts.tag) query.tag = opts.tag;
    if (opts.minPrice !== undefined) query.minPrice = opts.minPrice;
    if (opts.maxPrice !== undefined) query.maxPrice = opts.maxPrice;
    if (opts.currency) query.currency = opts.currency;
    if (opts.sort) query.sort = opts.sort;
    if (opts.page !== undefined) query.page = opts.page;
    if (opts.pageSize !== undefined) query.pageSize = opts.pageSize;
    const res = await client.request<'/store/v1/search', 'get', RawSearchResult>(
      'get',
      '/store/v1/search',
      { query },
    );
    return {
      products: (res.hits ?? []).map(toCardFromHit),
      facets: toFacetsView(res.facets),
      total: res.total ?? 0,
    };
  } catch {
    return { products: [], facets: EMPTY_FACETS, total: 0 };
  }
});

/**
 * Enumerate ALL published product slugs by paging the existing `/store/v1/products` cursor endpoint.
 * Pages with a bounded cap so a huge/looping catalog can't hang the build. Returns whatever was
 * collected; a transport error PROPAGATES so the sitemap caller can fall back to the static routes.
 */
export async function fetchAllProductSlugs(
  opts: {
    pageSize?: number;
    maxPages?: number;
  } = {},
): Promise<string[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 50;
  const client = createStoreClient();
  const slugs: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const query: { pageSize: number; cursor?: string } = { pageSize };
    if (cursor) query.cursor = cursor;
    const res = await client.request<'/store/v1/products', 'get', RawProductList>(
      'get',
      '/store/v1/products',
      { query },
    );
    for (const p of res.data ?? []) {
      if (p?.slug) slugs.push(p.slug);
    }
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return slugs;
}

/** Flatten every category slug (incl. nested children) from a tree node. */
function collectCategorySlugs(cat: RawCategory, out: string[]): void {
  if (cat?.slug) out.push(cat.slug);
  for (const child of cat.children ?? []) collectCategorySlugs(child, out);
}

/**
 * Enumerate ALL category slugs (incl. nested) via the existing `/store/v1/categories/tree` endpoint.
 * A transport error PROPAGATES so the sitemap caller can fall back to the static routes.
 */
export async function fetchAllCategorySlugs(): Promise<string[]> {
  const client = createStoreClient();
  const res = await client.request<'/store/v1/categories/tree', 'get', RawCategoryList>(
    'get',
    '/store/v1/categories/tree',
  );
  const slugs: string[] = [];
  for (const cat of res.data ?? []) collectCategorySlugs(cat, slugs);
  return slugs;
}

function toProductDetailView(p: RawProductDetail): ProductDetailView {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description ?? null,
    variants: (p.variants ?? []).map((v) => ({
      id: v.id,
      title: v.title ?? null,
      options: v.options ?? {},
      priceAmount: v.priceAmount,
      currency: v.currency,
      availability: v.availability,
    })),
    images: (p.images ?? []).map((img) => ({
      thumbnailUrl: img.thumbnailUrl,
      altText: img.altText ?? null,
    })),
  };
}

/**
 * Fetch a single published product by slug for the PDP. Returns `null` when the slug does not exist
 * (API 404) — the caller maps that to `notFound()`. A transport/unreachable error also returns
 * `null` (the page 404s rather than 500s on a cold API, consistent with `fetchCategoryBySlug` and
 * the rest of the catalog's graceful degradation).
 *
 * Wrapped in React `cache` so the PDP's `notFound` guard,
 * `generateMetadata`, and the section loaders (`product-main` + `breadcrumbs`) share ONE
 * `/store/v1/products/{slug}` round-trip per render pass. client-js uses the typed store client (not
 * native `fetch`), so Next's fetch dedup does NOT apply — `cache()` restores the single-request parity.
 * The cache memoises the RESOLVED value, so the null-return (404 / cold-API) behavior is preserved.
 */
export const fetchProductBySlug = cache(async (slug: string): Promise<ProductDetailView | null> => {
  try {
    const client = createStoreClient();
    const res = await client.request<'/store/v1/products/{slug}', 'get', RawProductDetail>(
      'get',
      '/store/v1/products/{slug}',
      { path: { slug } },
    );
    return toProductDetailView(res);
  } catch (err) {
    if (err instanceof SovEcomApiError && err.status === 404) return null;
    return null;
  }
});
