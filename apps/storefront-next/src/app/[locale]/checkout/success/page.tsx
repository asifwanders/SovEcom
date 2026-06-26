/**
 * Order confirmation route (`/checkout/success`). Server-rendered shell hosting the `CheckoutSuccess`
 * client island, which reads the order (logged-in via JWT, guest via the one-time X-Order-Token)
 * and handles the post-redirect PaymentIntent return. `noindex` — a transactional,
 * session/order-specific page must never be indexed.
 *
 * The page is a pure READ surface: re-loading it (browser-back after payment) never creates an order or
 * charges — the order was already created at the payment step (`/checkout` + `/payment-intent`).
 */
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { CheckoutSuccess } from '@/components/checkout/CheckoutSuccess';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'payment' });
  return {
    ...buildRouteMetadata({
      origin: siteOrigin(),
      locale,
      path: '/checkout/success',
      title: t('successTitle'),
    }),
    robots: { index: false, follow: false },
  };
}

export default async function CheckoutSuccessPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('payment');

  return (
    <section aria-labelledby="success-heading" className="mx-auto max-w-2xl px-4 py-8">
      <h1 id="success-heading" className="mb-6 text-2xl font-bold text-foreground">
        {t('successTitle')}
      </h1>
      {/* useSearchParams requires a Suspense boundary in the App Router. */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">{t('loadingOrder')}</p>}>
        <CheckoutSuccess />
      </Suspense>
    </section>
  );
}
