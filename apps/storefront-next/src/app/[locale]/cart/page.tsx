/**
 * cart page route (`/cart`).
 *
 * RSC shell: localized heading + metadata, hosting the `CartPageView` client island. The cart itself is
 * per-session client state (client-side only — no SSR — cart is per-session), so the page is NOT
 * statically prerendered with cart data; the shell is the only server-rendered part.
 *
 * The header cart icon opens the drawer; the drawer's "View cart" link and any direct navigation
 * land here for the full cart experience (discount + shipping estimator + full totals).
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import { fetchActiveTheme } from '@/lib/theme';
import { resolveActiveThemeName } from '@/themes/active-theme';
import type { Locale } from '@/i18n/routing';
import { CartPageView } from '@/components/cart/CartPageView';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'cart' });
  return buildRouteMetadata({
    origin: siteOrigin(),
    locale,
    path: '/cart',
    title: t('page.title'),
  });
}

export default async function CartPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('cart');

  // Resolve the active theme name in the RSC shell (the cart body is a client island that can't fetch
  // the theme) and pass it to `CartPageView` so the cart honours the active theme's `cart` template —
  // default → default cart (parity); boutique → boutique cart.json. Same shared resolver as the pages.
  // Also pass the active theme's delivered `cart` template — already defensively validated in
  // `fetchActiveTheme` — so an installed theme's cart template wins over the bundled set;
  // absent → `CartPageView` falls back to `resolveTemplateSet(name).cart` (parity).
  const theme = await fetchActiveTheme();
  const themeName = resolveActiveThemeName(theme);
  const wireCartTemplate = theme?.templates?.cart;

  return (
    <section aria-labelledby="cart-heading" className="mx-auto max-w-6xl px-4 py-8">
      <h1 id="cart-heading" className="mb-6 text-2xl font-bold text-foreground">
        {t('page.title')}
      </h1>
      <CartPageView themeName={themeName} cartTemplate={wireCartTemplate} />
    </section>
  );
}
