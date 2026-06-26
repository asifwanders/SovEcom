/**
 * Search results sections — the search listing body decomposed onto the
 * section runtime, parity-neutral. The search `<form>`, heading, and the empty-`q` branch stay
 * PAGE-LEVEL (the page only composes these sections when `q` is present). RSC loaders read
 * `ctx.searchParams`; the interactive components (`SortControl`, `FilterSidebar`, `ProductGrid`,
 * `Pagination`) are reused VERBATIM. All four result-set loaders share ONE cached `fetchSearch` via
 * the `cache()`-stable `searchSearchArgs` builder → a single round-trip per render pass.
 *
 * Unlike the category PLP, the category facet is SELECTABLE here (no `fixedCategory`), and every
 * carried-param map includes `q` so navigation preserves the query (verbatim from the pre-refactor
 * page). The result-count + sort row + no-results text + grid markup are byte-for-byte the original.
 */
import { getTranslations } from 'next-intl/server';
import { fetchSearch, type SearchResultView } from '@/lib/catalog';
import { ProductGrid } from '@/components/ProductGrid';
import { productCardActions } from '@/components/cardActions';
import { Pagination } from '@/components/Pagination';
import { FilterSidebar } from '@/components/FilterSidebar';
import { SortControl } from '@/components/SortControl';
import type { Section, SectionContext, SectionSettings } from '@/lib/sections/registry';
import {
  parseQuery,
  searchSearchArgs,
  PAGE_SIZE,
  type ParsedQuery,
} from '@/lib/sections/search-args';
import type { Locale } from '@/i18n/routing';

/** Run the shared cached search for the current query (the `q`-present branch is page-gated). */
async function search(
  ctx: SectionContext,
): Promise<{ result: SearchResultView; query: ParsedQuery }> {
  const query = parseQuery(ctx.searchParams);
  const result = await fetchSearch(searchSearchArgs(query));
  return { result, query };
}

/** The carried-params map every search link preserves (verbatim from the pre-refactor page). */
function carriedParams(query: ParsedQuery): Record<string, string> {
  const carried: Record<string, string> = { q: query.q };
  if (query.sort !== 'relevance') carried.sort = query.sort;
  if (query.category) carried.category = query.category;
  if (query.minPrice !== undefined) carried.minPrice = String(query.minPrice);
  if (query.maxPrice !== undefined) carried.maxPrice = String(query.maxPrice);
  if (query.currency) carried.currency = query.currency;
  return carried;
}

// ── search-results-header (count + SortControl when results > 0) ───────────────────────────────

interface SearchHeaderData {
  total: number;
  query: ParsedQuery;
  hasProducts: boolean;
}

async function loadSearchHeader(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<SearchHeaderData> {
  const { result, query } = await search(ctx);
  return { total: result.total, query, hasProducts: result.products.length > 0 };
}

async function SearchResultsHeader({
  data,
  locale,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const t = await getTranslations('search');
  const d = data as SearchHeaderData | undefined;
  if (!d) return null;
  const { query } = d;
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm text-muted-foreground">{t('resultCount', { count: d.total })}</p>
      {d.hasProducts && (
        <SortControl
          locale={locale as Locale}
          action={`/${locale}/search`}
          sort={query.sort}
          preserve={{
            q: query.q,
            ...(query.category ? { category: query.category } : {}),
            ...(query.minPrice !== undefined ? { minPrice: String(query.minPrice) } : {}),
            ...(query.maxPrice !== undefined ? { maxPrice: String(query.maxPrice) } : {}),
            ...(query.currency ? { currency: query.currency } : {}),
          }}
        />
      )}
    </div>
  );
}

export const SearchResultsHeaderSection: Section = {
  type: 'search-results-header',
  loader: loadSearchHeader,
  Component: SearchResultsHeader,
};

// ── search-filter-sidebar (FilterSidebar with the SELECTABLE category facet) ───────────────────

interface SearchSidebarData {
  result: SearchResultView;
  priceCurrency: string;
}

async function loadSearchSidebar(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<SearchSidebarData> {
  const { result, query } = await search(ctx);
  const priceCurrency = query.currency ?? result.products[0]?.currency ?? 'EUR';
  return { result, priceCurrency };
}

function SearchFilterSidebar({
  data,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const d = data as SearchSidebarData | undefined;
  if (!d) return null;
  return <FilterSidebar facets={d.result.facets} currency={d.priceCurrency} />;
}

export const SearchFilterSidebarSection: Section = {
  type: 'search-filter-sidebar',
  loader: loadSearchSidebar,
  Component: SearchFilterSidebar,
};

// ── search-product-grid (no-results state OR the grid) ─────────────────────────────────────────

interface SearchGridData {
  result: SearchResultView;
  query: ParsedQuery;
}

async function loadSearchGrid(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<SearchGridData> {
  return search(ctx);
}

async function SearchProductGrid({
  data,
  locale,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const t = await getTranslations('search');
  const d = data as SearchGridData | undefined;
  const products = d?.result.products ?? [];
  if (products.length === 0) {
    return <p className="text-muted-foreground">{t('noResults', { query: d?.query.q ?? '' })}</p>;
  }
  return <ProductGrid products={products} locale={locale} cardActions={productCardActions} />;
}

export const SearchProductGridSection: Section = {
  type: 'search-product-grid',
  loader: loadSearchGrid,
  Component: SearchProductGrid,
};

// ── search-pagination ──────────────────────────────────────────────────────────────────────────

interface SearchPaginationData {
  page: number;
  total: number;
  params: Record<string, string>;
  hasProducts: boolean;
}

async function loadSearchPagination(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<SearchPaginationData> {
  const { result, query } = await search(ctx);
  return {
    page: query.page,
    total: result.total,
    params: carriedParams(query),
    hasProducts: result.products.length > 0,
  };
}

function SearchPagination({ data }: { settings: SectionSettings; data: unknown; locale: string }) {
  const d = data as SearchPaginationData | undefined;
  // The pre-refactor page only renders Pagination alongside a non-empty grid (inside the results
  // branch). Mirror that: no products → no pagination (the Pagination component also returns null on
  // a single page, but gating on products keeps the empty-results DOM identical to the original).
  if (!d || !d.hasProducts) return null;
  return (
    <Pagination
      basePath="/search"
      page={d.page}
      pageSize={PAGE_SIZE}
      total={d.total}
      params={d.params}
    />
  );
}

export const SearchPaginationSection: Section = {
  type: 'search-pagination',
  loader: loadSearchPagination,
  Component: SearchPagination,
};
