/**
 * Locale-scoped root layout with sub-path locale routing.
 *
 * Responsibilities:
 * - Render `<html lang={locale} dir={...}>` driven by the active locale (RTL-ready;
 *     `localeDirection` returns 'ltr' for en/fr, flips for a future RTL locale with no rewrite).
 * - Fetch the active theme server-side + apply its CSS vars to <body>;
 *   null/partial/malformed theme falls back to the :root defaults, never crashes.
 * - Wrap children in `NextIntlClientProvider` so client components (the language switcher) get the
 *     active locale + messages; `setRequestLocale(locale)` keeps the layout statically renderable for ISR.
 * - Localize the metadata title/description via `getTranslations`.
 *
 * An unknown `[locale]` segment → `notFound()` (deterministic; mirrors the catalog 404 posture).
 */
import type { Metadata } from 'next';
import '@fontsource/ubuntu/400.css';
import '@fontsource/ubuntu/500.css';
import '@fontsource/ubuntu/700.css';
import '../globals.css';
import type { CSSProperties } from 'react';
import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { fetchActiveTheme, themeToCssVars, themeLogoUrl } from '@/lib/theme';
import { bundledDefaultSettings } from '@/themes';
import { resolveActiveThemeName } from '@/themes/active-theme';
import { readHeaderLayout, readCartAffordance } from '@/lib/chrome-variants';
import { THEME_INIT_SCRIPT } from '@/lib/theme-mode';
import { routing, localeDirection } from '@/i18n/routing';
import { siteOrigin, buildOrganizationJsonLd, buildWebSiteJsonLd } from '@/lib/seo';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieBanner } from '@/components/CookieBanner';
import { ConsentProvider } from '@/lib/consent';
import { AnalyticsScripts } from '@/components/AnalyticsScripts';
import { StructuredData } from '@/components/StructuredData';
import { StorefrontProviders } from '@/lib/providers';

/** Prerender both locale shells at build time (ISR-friendly). */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  // Use the resolved (validated) locale for the namespace; an invalid one is handled in the layout.
  const resolvedLocale = hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
  const t = await getTranslations({ locale: resolvedLocale, namespace: 'metadata' });
  // `metadataBase` lets Next resolve any relative URL (OG images etc.) against the site origin.
  // Per-route `generateMetadata` emits absolute canonical/hreflang URLs on top of it.
  return {
    metadataBase: new URL(siteOrigin()),
    title: { default: t('title'), template: `%s · ${t('title')}` },
    description: t('description'),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Reject unknown locales deterministically (mirrors fetchCategoryBySlug 404 → notFound).
  if (!hasLocale(routing.locales, locale)) notFound();
  // Opt the statically-rendered tree into the request locale (required for static/ISR pages).
  setRequestLocale(locale);

  // Fetch the active theme server-side and map its settings onto the globals.css CSS custom
  // properties. `fetchActiveTheme` returns null on error, and `themeToCssVars` yields {} for
  // a null/partial/malformed theme — so the `:root` defaults always show through and the layout never crashes.
  const theme = await fetchActiveTheme();

  // Resolve the active theme name via the shared helper — ensures chrome + tokens + templates use
  // the same name. Precedence: build/dev override env → API theme name → 'default'.
  // Layer bundled per-theme default settings under the live API settings so the API wins.
  const activeThemeName = resolveActiveThemeName(theme);
  const effectiveSettings: Readonly<Record<string, unknown>> = {
    ...bundledDefaultSettings(activeThemeName),
    ...(theme?.settings ?? {}),
  };

  // Feed effective settings into the token mapper + chrome-variant readers.
  // `themeToCssVars` reads `.settings`, so wrap the effective bag in a theme-shaped view.
  const effectiveTheme = {
    name: activeThemeName,
    version: theme?.version ?? '',
    settings: effectiveSettings,
  };
  const themeVars = themeToCssVars(effectiveTheme) as CSSProperties;
  const logoUrl = themeLogoUrl(effectiveTheme);
  const headerLayout = readHeaderLayout(effectiveSettings);
  const cartAffordance = readCartAffordance(effectiveSettings);
  const tSkip = await getTranslations('skip');

  // Site-wide JSON-LD: Organization + WebSite. Brand name is the active theme's name or
  // the localized header brand string; logo is the theme logo.
  const origin = siteOrigin();
  const tHeader = await getTranslations('header');
  const brandName = theme?.name?.trim() || tHeader('brand');
  const organizationLd = buildOrganizationJsonLd(origin, brandName, logoUrl);
  const webSiteLd = buildWebSiteJsonLd(origin, brandName);

  return (
    // `suppressHydrationWarning`: the no-FOUC inline script toggles the `.dark` class before
    // hydration (standard Next dark-mode pattern to prevent flash).
    <html lang={locale} dir={localeDirection(locale)} suppressHydrationWarning>
      <head>
        {/* No-FOUC dark-mode bootstrap: reads the `theme` cookie and sets `.dark` class
            before first paint to prevent flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Runtime config: API base URL is resolved server-side at request time so one
            Docker image works on any domain — no baked-in build arg needed.
            Client components (cart, auth, wishlists) read window.__SOVECOM__.apiBaseUrl. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__SOVECOM__=${JSON.stringify({
              apiBaseUrl:
                process.env.API_BASE_URL ||
                process.env.NEXT_PUBLIC_API_BASE_URL ||
                'http://localhost:3000',
            })};`,
          }}
        />
      </head>
      <body
        className="bg-background text-foreground font-sans min-h-screen flex flex-col"
        style={themeVars}
      >
        {/* Skip-to-content: visually hidden until focused, jumps to <main>. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {tSkip('toContent')}
        </a>
        {/* Site-wide structured data — Organization + WebSite, emitted once site-wide. */}
        <StructuredData data={organizationLd} />
        <StructuredData data={webSiteLd} />
        <NextIntlClientProvider>
          {/* Consent state wraps the banner + analytics so a choice in the banner
              mounts/unmounts the trackers without a reload. */}
          <ConsentProvider>
            {/* Transactional client contexts: auth + cart, wired so the cart's Bearer
                follows a logged-in customer. A client boundary that still renders RSC children. */}
            <StorefrontProviders>
              <Header
                logoUrl={logoUrl}
                headerLayout={headerLayout}
                cartAffordance={cartAffordance}
              />
              <main id="main-content" className="flex-1">
                {children}
              </main>
              <Footer />
              <CookieBanner />
            </StorefrontProviders>
            {/* Plausible (cookieless) + GA4/Meta (consent-gated). Config piggybacks the theme fetch. */}
            <AnalyticsScripts config={theme?.analytics} />
          </ConsentProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
