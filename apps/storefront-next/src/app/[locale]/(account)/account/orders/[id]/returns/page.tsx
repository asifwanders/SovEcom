/**
 * customer return / 14-day right-of-withdrawal request page. RSC
 * shell: locale + noindex metadata (private account area), hosting the `ReturnRequest` client island.
 * Auth is enforced by the `(account)` group layout's `AccountGate`.
 *
 * The `[id]` segment is the order UUID. The endpoints the island calls are `CustomerAuthGuard`-scoped
 * + IDOR-protected (the server 404s an order the customer does not own, 422s a non-returnable status
 * or an over-quantity item). The island re-checks returnable eligibility for a friendly not-eligible
 * state on a direct navigation, but the server remains the source of truth.
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { ReturnRequest } from '@/components/account/ReturnRequest';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale; id: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'account.returns' });
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

export default async function AccountOrderReturnsPage({
  params,
}: {
  params: Promise<{ locale: Locale; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  return <ReturnRequest orderId={id} />;
}
