/**
 * Search results page with Meilisearch integration.
 * Query-driven, so the page is DYNAMIC (`force-dynamic`). An empty query renders the form with a
 * prompt (no fetch); a non-empty query composes the results from the active theme's `search`
 * template via the section runtime (`renderSections`) — a `columns` layout wrapping
 * `search-filter-sidebar` + `search-results-header` + `search-product-grid` + `search-pagination`.
 * The empty-results / no-results / cold-API states are handled inside those sections (graceful empty).
 *
 * PAGE-LEVEL: `force-dynamic`, `generateMetadata` (noindex), the search `<form>` + heading,
 * the empty-`q` branch, the outer container. Chrome is localized via the `search` namespace;
 * search data stays single-language. The native form is locale-prefixed; the section
 * `Pagination`/`SortControl` are locale-aware.
 */
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { fetchActiveTheme } from '@/lib/theme';
import { resolveActiveThemeName } from '@/themes/active-theme';
import { renderSections } from '@/lib/sections/renderSections';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';

// Search is query-driven → render dynamically per request (no ISR cache).
export const dynamic = 'force-dynamic';

/**
 * Search metadata: localized title/description, canonical to the clean `/search` URL +
 * hreflang. Search result pages are query permutations (thin/duplicate content), so they are marked
 * `noindex, follow` — crawlers follow the product links out but don't index every `?q=` variant.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const [tSearch, tSeo] = await Promise.all([
    getTranslations({ locale, namespace: 'search' }),
    getTranslations({ locale, namespace: 'seo' }),
  ]);
  const md = buildRouteMetadata({
    origin: siteOrigin(),
    locale,
    path: '/search',
    title: tSearch('title'),
    description: tSeo('searchDescription'),
  });
  return { ...md, robots: { index: false, follow: true } };
}

/** Parse the raw `searchParams` into a plain `Record<string,string>` for the section runtime. */
function toRecord(sp: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{
    q?: string;
    page?: string;
    sort?: string;
    category?: string;
    minPrice?: string;
    maxPrice?: string;
    currency?: string;
  }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('search');
  const sp = toRecord(await searchParams);
  const q = (sp.q ?? '').trim();

  // Compose the results body from the active theme's `search` template only when there's a query —
  // the empty-`q` branch (prompt) stays page-level (no fetch). `themeName` from the cached theme.
  const theme = q ? await fetchActiveTheme() : null;
  const sections = q
    ? await renderSections({
        page: 'search',
        themeName: resolveActiveThemeName(theme),
        wireTemplates: theme?.templates,
        locale,
        searchParams: sp,
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">{t('title')}</h1>

      <form className="flex items-center gap-3 mb-6" action={`/${locale}/search`}>
        <label htmlFor="q" className="sr-only">
          {t('placeholder')}
        </label>
        <Input id="q" name="q" defaultValue={q} placeholder={t('placeholder')} className="flex-1" />
        <Button type="submit" variant="primary" size="md">
          {t('submit')}
        </Button>
      </form>

      {!q ? <p className="text-muted-foreground">{t('prompt')}</p> : sections}
    </div>
  );
}
