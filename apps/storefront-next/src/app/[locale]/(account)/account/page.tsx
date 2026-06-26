/**
 * customer account dashboard page. RSC shell (locale +
 * metadata) hosting the `AccountDashboard` client island. Private page → `robots: noindex` so the
 * authenticated area is never indexed. The `AccountGate` in the group layout enforces auth.
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { AccountDashboard } from '@/components/account/AccountDashboard';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'account.dashboard' });
  return {
    ...buildRouteMetadata({ origin: siteOrigin(), locale, path: '/account', title: t('title') }),
    robots: { index: false, follow: false },
  };
}

export default async function AccountDashboardPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <AccountDashboard />;
}
