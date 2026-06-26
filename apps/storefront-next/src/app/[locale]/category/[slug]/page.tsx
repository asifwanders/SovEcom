/**
 * Category PLP. Lists a category's published products. RSC, dynamic per request (reads `searchParams`).
 *
 * the listing BODY is now composed from the active theme's `category` template via the
 * section runtime (`renderSections`) — `category-header`, `category-sort`, and a `columns` layout
 * wrapping `category-filter-sidebar` + `category-product-grid` + `category-pagination`. Those sections
 * reuse the same interactive components (SortControl / FilterSidebar / ProductGrid / Pagination) and
 * read ONE cached `fetchSearch` (shared, `cache()`-stable args). PAGE-LEVEL (unchanged for parity/SEO):
 * the `notFound` guard, `generateMetadata` (canonical omits sort/page/price), `setRequestLocale`, the
 * outer container, the visible `<Breadcrumbs>`, and the BreadcrumbList JSON-LD.
 *
 * chrome localized via the `category` namespace. Category DATA (name) + the search fetch stay
 * single-language. The native sort `<form action>` is locale-prefixed (in the section);
 * the `Pagination` `basePath` stays locale-LESS (its next-intl `Link` prefixes the locale itself).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { fetchCategoryBySlug } from '@/lib/catalog';
import { fetchActiveTheme } from '@/lib/theme';
import { resolveActiveThemeName } from '@/themes/active-theme';
import { renderSections } from '@/lib/sections/renderSections';
import { Breadcrumbs, type BreadcrumbItem } from '@/components/Breadcrumbs';
import { StructuredData } from '@/components/StructuredData';
import { siteOrigin, buildBreadcrumbJsonLd } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';

/**
 * Category PLP metadata: the category name is the localized title (category data stays
 * single-language), with canonical + hreflang alternates. The canonical deliberately
 * OMITS the `?sort/?page/?minPrice/...` params so every filtered/sorted/paged variant of a category
 * canonicalizes to the clean category URL (avoids duplicate-content indexing). An unknown slug → {}.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const category = await fetchCategoryBySlug(slug);
  if (!category) return {};
  return buildRouteMetadata({
    origin: siteOrigin(),
    locale,
    path: `/category/${slug}`,
    title: category.name,
  });
}

// This route reads `searchParams` (sort + page + price), so Next renders it dynamically per request —
// an `export const revalidate` would be inert here, so we deliberately omit it.

/** Parse the raw `searchParams` into a plain `Record<string,string>` for the section runtime. */
function toRecord(sp: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale; slug: string }>;
  searchParams: Promise<{
    sort?: string;
    page?: string;
    minPrice?: string;
    maxPrice?: string;
    currency?: string;
  }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const sp = toRecord(await searchParams);

  // PAGE-LEVEL guard (parity/SEO): 404 an unknown slug + build the breadcrumb trail/JSON-LD. The fetch
  // is `cache`-wrapped, so this guard, `generateMetadata`, and the `category-header`
  // section loader share ONE `/store/v1/categories/{slug}` round-trip per render pass.
  const category = await fetchCategoryBySlug(slug);
  if (!category) notFound();

  // Crumb trail AFTER Home — shared by <Breadcrumbs> (prepends Home) + the BreadcrumbList JSON-LD.
  const t = await getTranslations('category');
  const crumbsAfterHome: BreadcrumbItem[] = [
    { label: t('categoriesRoot'), href: '/category' },
    { label: category.name, href: `/category/${slug}` },
  ];
  const origin = siteOrigin();
  const tBc = await getTranslations('breadcrumbs');
  const breadcrumbLd = buildBreadcrumbJsonLd(origin, locale, [
    { label: tBc('home'), href: '/' },
    ...crumbsAfterHome,
  ]);

  // Compose the listing body from the active theme's `category` template. `themeName`
  // comes from the `cache()`-wrapped `fetchActiveTheme` (shared with the layout); the route slug +
  // parsed searchParams are threaded to the section loaders.
  const theme = await fetchActiveTheme();
  const sections = await renderSections({
    page: 'category',
    themeName: resolveActiveThemeName(theme),
    wireTemplates: theme?.templates,
    locale,
    params: { slug },
    searchParams: sp,
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* Category structured data: BreadcrumbList — kept page-level. */}
      <StructuredData data={breadcrumbLd} />
      <Breadcrumbs items={crumbsAfterHome} />
      {sections}
    </div>
  );
}
