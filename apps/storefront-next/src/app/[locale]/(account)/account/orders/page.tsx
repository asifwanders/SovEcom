/**
 * customer order-history list page. RSC shell:
 * locale + noindex metadata, hosting the `OrdersList` client island. Auth enforced by the group
 * layout's `AccountGate`.
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { OrdersList } from '@/components/account/OrdersList';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'account.orders' });
  return {
    ...buildRouteMetadata({
      origin: siteOrigin(),
      locale,
      path: '/account/orders',
      title: t('title'),
    }),
    robots: { index: false, follow: false },
  };
}

export default async function AccountOrdersPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <OrdersList />;
}
