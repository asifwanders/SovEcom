/**
 * Home page: hero + featured products + categories. RSC, ISR 60s.
 *
 * The page body is composed from a template via the section runtime (`renderSections`) instead
 * of inline JSX. The hero/featured/category markup lives in `@/components/sections/*` and the
 * order comes from the active theme's `home` template (falling back to the bundled `default` set).
 * Catalog reads are inside the section loaders; a cold/unreachable API degrades to empty sections.
 * UI chrome is localized via the `home` namespace. Catalog data stays single-language.
 */
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { fetchActiveTheme } from '@/lib/theme';
import { resolveActiveThemeName } from '@/themes/active-theme';
import { renderSections } from '@/lib/sections/renderSections';
import { Slot } from '@/components/Slot';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';

// ISR: home revalidates every 60s.
export const revalidate = 60;

/** Home metadata: localized title/description + canonical + hreflang for `/`. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const [tHome, tSeo] = await Promise.all([
    getTranslations({ locale, namespace: 'home' }),
    getTranslations({ locale, namespace: 'seo' }),
  ]);
  return buildRouteMetadata({
    origin: siteOrigin(),
    locale,
    path: '/',
    title: tHome('heroTitle'),
    description: tSeo('homeDescription'),
  });
}

export default async function HomePage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Pick the active theme's name (null/unreachable → bundled `default` set), then compose
  // the page from its `home` template via the section runtime.
  const theme = await fetchActiveTheme();
  const sections = await renderSections({
    page: 'home',
    themeName: resolveActiveThemeName(theme),
    wireTemplates: theme?.templates,
    locale,
  });

  // Module slot: the `home-page-bottom` canonical slot. Renders nothing unless a module
  // binds it (and resolves cleanly); a failing/empty module is invisible. `<Slot>` is its own async RSC,
  // so it streams independently and never blocks the sections above.
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 space-y-10">
      {sections}
      <Slot name="home-page-bottom" route="/" />
    </div>
  );
}
