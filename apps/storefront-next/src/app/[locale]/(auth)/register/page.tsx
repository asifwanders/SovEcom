/**
 * customer registration page. AUTH-CRITICAL.
 *
 * RSC shell (title/subtitle + metadata, locale-aware) hosting the `RegisterForm` client island. The
 * form signs up + auto-logs-in via the auth context (no Server Actions). On full success it redirects to
 * the locale home (`/`); on a signup-ok-but-login-failed partial state it routes to login with the
 * "account created — please sign in" notice.
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { RegisterForm } from '@/components/auth/RegisterForm';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'auth' });
  return buildRouteMetadata({
    origin: siteOrigin(),
    locale,
    path: '/register',
    title: t('register.title'),
  });
}

export default async function RegisterPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth');

  return (
    <section aria-labelledby="register-heading" className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 id="register-heading" className="text-2xl font-bold text-foreground">
          {t('register.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('register.subtitle')}</p>
      </header>
      <RegisterForm />
    </section>
  );
}
