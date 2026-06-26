/**
 * customer security page. RSC shell hosting the credential
 * management islands: ChangeEmailForm + ChangePasswordForm, under a page header. Auth enforced by the
 * group layout's AccountGate. Marked noindex — private account area.
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { ChangeEmailForm } from '@/components/account/ChangeEmailForm';
import { ChangePasswordForm } from '@/components/account/ChangePasswordForm';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'account.security' });
  return {
    ...buildRouteMetadata({
      origin: siteOrigin(),
      locale,
      path: '/account/security',
      title: t('pageTitle'),
    }),
    robots: { index: false, follow: false },
  };
}

export default async function AccountSecurityPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'account.security' });
  return (
    <section aria-labelledby="security-heading" className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 id="security-heading" className="text-2xl font-bold text-foreground">
          {t('pageTitle')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('pageSubtitle')}</p>
      </header>
      <ChangeEmailForm />
      <ChangePasswordForm />
    </section>
  );
}
