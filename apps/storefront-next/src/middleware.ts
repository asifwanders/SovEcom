/**
 * Next-intl locale-routing middleware.
 *
 * Drives the `/en` and `/fr` sub-path routing: it detects the locale (cookie → Accept-Language →
 * default), redirects a bare `/` to the default-locale path (per routing config with `localePrefix:
 * 'always'`), and persists the visitor's last choice in next-intl's cookie. The matcher excludes
 * `_next` internals, the API namespace, and any path with a file extension (static assets like
 * `/favicon.svg`) so only real page routes are localized — assets and data routes pass through
 * untouched.
 */
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

export default createMiddleware(routing);

export const config = {
  // Match all pathnames except those starting with /api, /_next, /_vercel, or containing a dot
  // (static files). This is the next-intl-recommended matcher, narrowed to this app's surfaces.
  matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
};
