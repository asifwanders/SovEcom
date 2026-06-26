/**
 * customer address book page. RSC shell: sets locale,
 * noindex metadata, then mounts the `AddressBook` client island. Auth enforced by the group gate.
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { AddressBook } from '@/components/account/AddressBook';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'account.nav' });
  return {
    ...buildRouteMetadata({
      origin: siteOrigin(),
      locale,
      path: '/account/addresses',
      title: t('addresses'),
    }),
    robots: { index: false, follow: false },
  };
}

export default async function AccountAddressesPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <AddressBook />;
}
