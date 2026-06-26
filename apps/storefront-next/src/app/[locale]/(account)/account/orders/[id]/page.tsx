/**
 * customer order detail page. RSC shell: locale +
 * noindex metadata (private account area), hosting the `OrderDetail` client island. Auth enforced
 * by the `(account)` group layout's `AccountGate`.
 *
 * The `[id]` segment is the order UUID. IDOR protection is server-side: the
 * `GET /store/v1/orders/{id}` endpoint is `CustomerAuthGuard`-scoped to the principal — any
 * attempt to read another customer's order returns 404 (not 403 — to avoid oracle). The
 * `OrderDetail` component renders a not-found state on a 404.
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { OrderDetail } from '@/components/account/OrderDetail';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale; id: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'account.orders' });
  return {
    ...buildRouteMetadata({
      origin: siteOrigin(),
      locale,
      path: '/account/orders',
      title: t('detailTitle'),
    }),
    robots: { index: false, follow: false },
  };
}

export default async function AccountOrderDetailPage({
  params,
}: {
  params: Promise<{ locale: Locale; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  return <OrderDetail orderId={id} />;
}
