/**
 * Shared per-route metadata builder.
 *
 * Every storefront `generateMetadata` calls `buildRouteMetadata` so canonical + hreflang + OG +
 * Twitter are constructed ONE way (DRY + consistent). It is a pure function over a logical path +
 * locale + title/description (+ optional OG images) — `metadataBase` itself is set once in the root
 * layout so Next resolves any relative URL; here we emit ABSOLUTE canonical/alternate/OG URLs (built
 * from the resolved `origin`) so they are correct regardless of `metadataBase`.
 *
 * No fetch here — the routes resolve their title/description from catalog data / `pages` SEO fields /
 * the message catalog, then hand the strings to this builder.
 */
import type { Metadata } from 'next';
import { absoluteUrl, localizedPath, localePathAlternates } from './seo';
import type { Locale } from '@/i18n/routing';

export interface RouteMetadataInput {
  /** Resolved site origin (from `siteOrigin(process.env)`). */
  origin: string;
  /** The active route locale. */
  locale: Locale;
  /** Logical, locale-LESS root-relative path (e.g. `/products`, `/product/tee`, `/`). */
  path: string;
  /** Localized page title. */
  title: string;
  /** Localized page description (omitted from output when undefined). */
  description?: string;
  /** OpenGraph type — `website` for listings/home, `article` for content pages. Defaults to `website`. */
  ogType?: 'website' | 'article';
  /** Absolute image URLs for OG/Twitter (e.g. the PDP product image). Omitted when empty. */
  images?: string[];
}

/**
 * Build a Next `Metadata` object with canonical (current-locale URL), `languages` hreflang
 * alternates (all locales), OpenGraph, and a Twitter card. The Twitter card is `summary` by default
 * and upgrades to `summary_large_image` when an image is supplied.
 */
export function buildRouteMetadata(input: RouteMetadataInput): Metadata {
  const { origin, locale, path, title, description, ogType = 'website', images } = input;
  const canonical = absoluteUrl(origin, localizedPath(locale, path));
  const languages = localePathAlternates(origin, path);
  const hasImages = !!images && images.length > 0;

  return {
    title,
    ...(description ? { description } : {}),
    alternates: { canonical, languages },
    openGraph: {
      url: canonical,
      type: ogType,
      title,
      ...(description ? { description } : {}),
      locale,
      ...(hasImages ? { images } : {}),
    },
    twitter: {
      card: hasImages ? 'summary_large_image' : 'summary',
      title,
      ...(description ? { description } : {}),
      ...(hasImages ? { images } : {}),
    },
  };
}
