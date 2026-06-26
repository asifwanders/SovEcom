/**
 * customer forgot-password page (`/forgot`). AUTH/CREDENTIAL-adjacent.
 *
 * RSC shell (title/subtitle + metadata, locale-aware) hosting the `ForgotPasswordForm` client island,
 * mirroring `login/page.tsx`. UNAUTH route under `(auth)` (a plain centered shell, NO AccountGate). The
 * form POSTs to the PUBLIC, enumeration-safe `POST /store/v1/customers/forgot` and always shows the same
 * uniform "if an account exists, check your inbox" banner. No `useSearchParams` here → NO Suspense.
 *
 * `noindex` — a transactional credential-recovery page must never be indexed.
 */
import type { Metadata } from 'next';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { ForgotPasswordForm } from '@/components/auth/ForgotPasswordForm';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'auth' });
  return {
    ...buildRouteMetadata({
      origin: siteOrigin(),
      locale,
      path: '/forgot',
      title: t('forgot.title'),
    }),
    robots: { index: false, follow: false },
  };
}

export default async function ForgotPasswordPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth');

  return (
    <section aria-labelledby="forgot-heading" className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 id="forgot-heading" className="text-2xl font-bold text-foreground">
          {t('forgot.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('forgot.subtitle')}</p>
      </header>
      <ForgotPasswordForm />
    </section>
  );
}
