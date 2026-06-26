/**
 * customer profile edit page. RSC shell: locale + noindex metadata, hosting
 * the `ProfileEditForm` client island. Auth enforced by the group layout's `AccountGate`. Credential
 * management (email/password) has moved to /account/security; privacy controls to /account/privacy.
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { ProfileEditForm } from '@/components/account/ProfileEditForm';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'account.profile' });
  return {
    ...buildRouteMetadata({
      origin: siteOrigin(),
      locale,
      path: '/account/profile',
      title: t('title'),
    }),
    robots: { index: false, follow: false },
  };
}

export default async function AccountProfilePage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <ProfileEditForm />;
}
