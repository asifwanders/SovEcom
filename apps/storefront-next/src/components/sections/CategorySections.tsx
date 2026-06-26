/**
 * Category PLP sections — the category listing decomposed onto the section
 * runtime, parity-neutral. Each section is RSC with a loader pulling from `ctx.params.slug` +
 * `ctx.searchParams`. They REUSE the existing interactive components VERBATIM (`SortControl`,
 * `FilterSidebar`, `ProductGrid`, `Pagination`) — no change to those components' param logic.
 *
 * The DOM is byte-identical to the pre-refactor page: a `category-header-row` section reproduces the
 * single `justify-between` row holding the `<h1>` AND the `<SortControl>` (above the sidebar grid); a
 * `category-filter-sidebar` section is the `columns` left region; a `category-results` section is the
 * results column reproducing the verbatim empty-vs-non-empty branch (the result-count `<p>` lives
 * INSIDE the results column, shown only when non-empty). The result-set sections all read ONE cached
 * `fetchSearch` via the shared, `cache()`-stable `categorySearchArgs` builder → a single round-trip.
 */
import { getTranslations } from 'next-intl/server';
import {
  fetchCategoryBySlug,
  fetchSearch,
  type CategoryView,
  type SearchResultView,
} from '@/lib/catalog';
import { ProductGrid } from '@/components/ProductGrid';
import { productCardActions } from '@/components/cardActions';
import { Pagination } from '@/components/Pagination';
import { FilterSidebar } from '@/components/FilterSidebar';
import { SortControl } from '@/components/SortControl';
import type { Section, SectionContext, SectionSettings } from '@/lib/sections/registry';
import {
  parseQuery,
  categorySearchArgs,
  PAGE_SIZE,
  type ParsedQuery,
} from '@/lib/sections/search-args';
import type { Locale } from '@/i18n/routing';

/** Resolve the route slug from the render ctx (empty string when absent — yields an empty result). */
function slugOf(ctx: SectionContext): string {
  return ctx.params?.slug ?? '';
}

// ── category-header-row (the verbatim `justify-between` row: h1 + SortControl) ──────────────────

interface CategoryHeaderRowData {
  category: CategoryView | null;
  slug: string;
  query: ParsedQuery;
}

async function loadCategoryHeaderRow(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<CategoryHeaderRowData> {
  const slug = slugOf(ctx);
  return { category: await fetchCategoryBySlug(slug), slug, query: parseQuery(ctx.searchParams) };
}

function CategoryHeaderRow({
  data,
  locale,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const d = data as CategoryHeaderRowData | undefined;
  if (!d?.category) return null;
  const { query } = d;
  // Verbatim from the pre-refactor page: the single `justify-between` row with the h1 + the sort
  // control (the sort `preserve` carries the active price filters, never `page`).
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
      <h1 className="text-2xl font-semibold">{d.category.name}</h1>
      <SortControl
        locale={locale as Locale}
        action={`/${locale}/category/${d.slug}`}
        sort={query.sort}
        preserve={{
          ...(query.minPrice !== undefined ? { minPrice: String(query.minPrice) } : {}),
          ...(query.maxPrice !== undefined ? { maxPrice: String(query.maxPrice) } : {}),
          ...(query.currency ? { currency: query.currency } : {}),
        }}
      />
    </div>
  );
}

export const CategoryHeaderRowSection: Section = {
  type: 'category-header-row',
  loader: loadCategoryHeaderRow,
  Component: CategoryHeaderRow,
};

// ── category-filter-sidebar (FilterSidebar with the price filter only; category fixed by route) ──

interface CategorySidebarData {
  result: SearchResultView;
  priceCurrency: string;
  slug: string;
}

async function loadCategorySidebar(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<CategorySidebarData> {
  const slug = slugOf(ctx);
  const query = parseQuery(ctx.searchParams);
  const result = await fetchSearch(categorySearchArgs(slug, query));
  const priceCurrency = query.currency ?? result.products[0]?.currency ?? 'EUR';
  return { result, priceCurrency, slug };
}

function CategoryFilterSidebar({
  data,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const d = data as CategorySidebarData | undefined;
  if (!d) return null;
  return (
    <FilterSidebar facets={d.result.facets} currency={d.priceCurrency} fixedCategory={d.slug} />
  );
}

export const CategoryFilterSidebarSection: Section = {
  type: 'category-filter-sidebar',
  loader: loadCategorySidebar,
  Component: CategoryFilterSidebar,
};

// ── category-results (the results column: empty state OR count + grid + pagination) ────────────

interface CategoryResultsData {
  result: SearchResultView;
  slug: string;
  page: number;
  params: Record<string, string>;
}

async function loadCategoryResults(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<CategoryResultsData> {
  const slug = slugOf(ctx);
  const query = parseQuery(ctx.searchParams);
  const result = await fetchSearch(categorySearchArgs(slug, query));
  // The page link params carry the active sort + price filters (verbatim from the pre-refactor page).
  const params: Record<string, string> = {};
  if (query.sort !== 'relevance') params.sort = query.sort;
  if (query.minPrice !== undefined) params.minPrice = String(query.minPrice);
  if (query.maxPrice !== undefined) params.maxPrice = String(query.maxPrice);
  if (query.currency) params.currency = query.currency;
  return { result, slug, page: query.page, params };
}

async function CategoryResults({
  data,
  locale,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const t = await getTranslations('category');
  const d = data as CategoryResultsData | undefined;
  const products = d?.result.products ?? [];
  // Verbatim empty-vs-non-empty branch from the pre-refactor results column: empty → the empty <p>;
  // non-empty → the result-count <p> (mb-4) + ProductGrid + Pagination.
  if (products.length === 0) {
    return <p className="text-muted-foreground">{t('empty')}</p>;
  }
  return (
    <>
      <p className="text-sm text-muted-foreground mb-4">
        {t('productCount', { count: d!.result.total })}
      </p>
      <ProductGrid products={products} locale={locale} cardActions={productCardActions} />
      <Pagination
        basePath={`/category/${d!.slug}`}
        page={d!.page}
        pageSize={PAGE_SIZE}
        total={d!.result.total}
        params={d!.params}
      />
    </>
  );
}

export const CategoryResultsSection: Section = {
  type: 'category-results',
  loader: loadCategoryResults,
  Component: CategoryResults,
};
