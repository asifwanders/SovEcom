/**
 * App-Router `robots.txt` route.
 *
 * Allows indexing of the public catalog (privacy-friendly / no-tracking stance needs nothing
 * special here), and disallows the internal SEARCH results path under every locale (`/en/search`,
 * `/fr/search`, …) — those are query permutations (thin/duplicate content), the same reason the
 * search route ships `robots: { index: false }`. References the absolute sitemap URL so crawlers
 * discover every catalog/page URL there. No new API, no tracking.
 */
import type { MetadataRoute } from 'next';
import { siteOrigin, absoluteUrl } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin();
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        // `/*/search` matches the locale-prefixed search route for any locale segment.
        disallow: ['/*/search'],
      },
    ],
    sitemap: absoluteUrl(origin, '/sitemap.xml'),
  };
}
