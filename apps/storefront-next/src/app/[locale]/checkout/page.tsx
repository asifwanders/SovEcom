/**
 * Checkout route (`/checkout`). The multi-step flow UP TO (not including) payment
 * (payment + confirmation are separate steps).
 *
 * RSC shell: localized heading + metadata, hosting the `CheckoutFlow` client island. Checkout is
 * per-session client state over the server-authoritative cart (client-side only), so
 * only the shell is server-rendered; the flow consumes the cart/auth contexts client-side. The route is
 * `noindex` (a transactional, session-specific page should never be indexed).
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { CheckoutFlow } from '@/components/checkout/CheckoutFlow';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'checkout' });
  return {
    ...buildRouteMetadata({
      origin: siteOrigin(),
      locale,
      path: '/checkout',
      title: t('title'),
    }),
    robots: { index: false, follow: false },
  };
}

export default async function CheckoutPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('checkout');

  return (
    <section aria-labelledby="checkout-heading" className="mx-auto max-w-6xl px-4 py-8">
      <h1 id="checkout-heading" className="mb-6 text-2xl font-bold text-foreground">
        {t('title')}
      </h1>
      <CheckoutFlow />
    </section>
  );
}
