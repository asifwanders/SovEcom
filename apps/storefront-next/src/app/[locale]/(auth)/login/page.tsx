/**
 * customer login page. AUTH-CRITICAL.
 *
 * RSC shell (title/subtitle + metadata, locale-aware) hosting the `LoginForm` client island. The form
 * authenticates via the in-memory auth context (no Server Actions) and redirects on success.
 *
 * Redirect target: a successful login lands on a validated `?returnTo=` internal path if present,
 * else the locale home (`/`). Future versions may default to an account dashboard instead.
 *
 * The page is NOT statically prerendered (it reads `searchParams`); it is a dynamic, no-store RSC.
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { LoginForm } from '@/components/auth/LoginForm';

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
    path: '/login',
    title: t('login.title'),
  });
}

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth');
  const sp = await searchParams;
  const returnToRaw = sp.returnTo;
  const returnTo = typeof returnToRaw === 'string' ? returnToRaw : undefined;
  const notice = sp.notice === 'account-created' ? 'account-created' : undefined;

  return (
    <section aria-labelledby="login-heading" className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 id="login-heading" className="text-2xl font-bold text-foreground">
          {t('login.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('login.subtitle')}</p>
      </header>
      <LoginForm returnTo={returnTo} notice={notice} />
    </section>
  );
}
