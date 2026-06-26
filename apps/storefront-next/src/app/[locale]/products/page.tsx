/**
 * All-products PLP. The "browse everything" surface the home hero + header nav link to.
 * RSC, ISR 5min (catalog-read cadence). Cursor pagination.
 *
 * the body is composed from the active theme's `products` template via the section runtime
 * (`renderSections`) — a FLAT template (no `columns`): `products-header`, the reused `product-grid`, and
 * `products-load-more`. The grid + load-more loaders share ONE cached `fetchProducts`. PAGE-LEVEL
 * (unchanged for parity/SEO): `revalidate=300`, `generateMetadata` (canonical omits `?cursor=`),
 * `setRequestLocale`, the outer container. Product DATA stays single-language.
 */
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { fetchActiveTheme } from '@/lib/theme';
import { resolveActiveThemeName } from '@/themes/active-theme';
import { renderSections } from '@/lib/sections/renderSections';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';

// ISR: products listing revalidates every 5 minutes (catalog-read cadence).
export const revalidate = 300;

/**
 * Products PLP metadata. The canonical is the clean `/products` URL — the `?cursor=`
 * pagination param is omitted so every page canonicalizes to the index (cursors are opaque + churn).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const [tProducts, tSeo] = await Promise.all([
    getTranslations({ locale, namespace: 'products' }),
    getTranslations({ locale, namespace: 'seo' }),
  ]);
  return buildRouteMetadata({
    origin: siteOrigin(),
    locale,
    path: '/products',
    title: tProducts('title'),
    description: tSeo('productsDescription'),
  });
}

/** Parse the raw `searchParams` into a plain `Record<string,string>` for the section runtime. */
function toRecord(sp: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export default async function ProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = toRecord(await searchParams);

  const theme = await fetchActiveTheme();
  const sections = await renderSections({
    page: 'products',
    themeName: resolveActiveThemeName(theme),
    wireTemplates: theme?.templates,
    locale,
    searchParams: sp,
  });

  return <div className="mx-auto max-w-6xl px-4 py-8">{sections}</div>;
}
