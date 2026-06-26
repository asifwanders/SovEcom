/**
 * next-intl routing config.
 *
 * Storefront i18n is URL sub-path based: `/en/...` and `/fr/...` are distinct, SEO-friendly URLs
 * required for per-locale `pages` rows and future JSON-LD. `localePrefix: 'always'`
 * makes BOTH locales explicit in the path (no implicit-default bare paths), so every public URL is
 * unambiguous and shareable, and `/` resolves to the default locale (English `en`) via the middleware.
 *
 * This config is the single source of truth for the locale set; `generateStaticParams`, the
 * middleware matcher, the request config, and the language switcher all derive from it. Adding a
 * future RTL locale is a one-line change here plus a catalog file — not a rewrite.
 */
import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
  locales: ['en', 'fr'],
  defaultLocale: 'en',
  // Always prefix the path with the locale so `/en/...` and `/fr/...` are both explicit.
  localePrefix: 'always',
});

/** The active locale union, derived from the routing config so the catalogs stay in lock-step. */
export type Locale = (typeof routing.locales)[number];

/**
 * Text direction for a locale (RTL-ready). FR/EN ship LTR; a future RTL locale only
 * needs an entry here and the layout's `<html dir>` flips automatically. Kept as a small explicit
 * map (rather than hard-coding `dir="ltr"`) so there is no LTR lock-in in the chrome.
 */
const RTL_LOCALES = new Set<string>([]);

export function localeDirection(locale: string): 'ltr' | 'rtl' {
  return RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}
