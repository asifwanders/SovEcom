/**
 * App-Router `sitemap.xml` route.
 *
 * Enumerates the storefront's indexable URLs, PER-LOCALE (locale-prefixed, `localePrefix: 'always'`)
 * with `alternates.languages` hreflang links:
 *   - static routes: home `/`, products index, category index, search;
 *   - dynamic product PDPs (`/product/{slug}`) + category PLPs (`/category/{slug}`), paged from the
 *     EXISTING `/store/v1/products` (cursor) + `/store/v1/categories/tree` endpoints — NO new API.
 *
 * Resilience: the dynamic enumeration is wrapped in try/catch — if the API is
 * unreachable at build time (cold API during `next build`), the sitemap degrades to just the static
 * routes rather than crashing the build. CMS `pages` are NOT enumerated: there is no list endpoint
 * for `pages` (only `GET /store/v1/pages/:slug`). Published pages are deliberately omitted here;
 * support can be added if/when a list endpoint exists or a known-slug allowlist is maintained.
 */
import type { MetadataRoute } from 'next';
import { fetchAllProductSlugs, fetchAllCategorySlugs } from '@/lib/catalog';
import { siteOrigin, absoluteUrl, localizedPath, localePathAlternates } from '@/lib/seo';
import { routing } from '@/i18n/routing';

// Revalidate the sitemap on the catalog-read cadence (5 min) so newly published products/categories
// appear without a redeploy, matching the PLP/PDP ISR window.
export const revalidate = 300;

/** A logical (locale-LESS) path → one sitemap entry per locale, with hreflang alternates. */
function entriesForPath(
  origin: string,
  path: string,
  changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'],
  priority: number,
): MetadataRoute.Sitemap {
  const languages = localePathAlternates(origin, path);
  return routing.locales.map((locale) => ({
    url: absoluteUrl(origin, localizedPath(locale, path)),
    lastModified: new Date(),
    changeFrequency,
    priority,
    alternates: { languages },
  }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();

  // Static routes — always present even if the API is down. `/search` is included for discovery but
  // is `noindex` at the page level (the sitemap lists it; the route's robots meta governs indexing).
  const staticPaths: Array<{
    path: string;
    freq: MetadataRoute.Sitemap[number]['changeFrequency'];
    priority: number;
  }> = [
    { path: '/', freq: 'daily', priority: 1 },
    { path: '/products', freq: 'daily', priority: 0.8 },
    { path: '/category', freq: 'weekly', priority: 0.6 },
    { path: '/search', freq: 'monthly', priority: 0.3 },
  ];
  const entries: MetadataRoute.Sitemap = staticPaths.flatMap((s) =>
    entriesForPath(origin, s.path, s.freq, s.priority),
  );

  // Dynamic catalog routes — best-effort; a cold/unreachable API degrades to the static routes only.
  try {
    const [productSlugs, categorySlugs] = await Promise.all([
      fetchAllProductSlugs(),
      fetchAllCategorySlugs(),
    ]);
    for (const slug of productSlugs) {
      entries.push(...entriesForPath(origin, `/product/${slug}`, 'weekly', 0.7));
    }
    for (const slug of categorySlugs) {
      entries.push(...entriesForPath(origin, `/category/${slug}`, 'weekly', 0.6));
    }
  } catch {
    // API unreachable at build time — return the static routes already collected (no crash).
  }

  return entries;
}
