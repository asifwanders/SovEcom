/**
 * customer reset-password page (`/reset`). AUTH/CREDENTIAL-CRITICAL.
 *
 * RSC shell (title/subtitle + metadata, locale-aware) hosting the `ResetPasswordForm` client island,
 * mirroring `account/email-confirm/page.tsx`. UNAUTH route under `(auth)` (a plain centered shell, NO
 * AccountGate) — the reset link is clicked from an email and the visitor is logged OUT. The one-time
 * `token` lives only in the query and is consumed by the client island; this RSC shell never touches it.
 *
 * The island uses `useSearchParams`, so a `<Suspense>` boundary is REQUIRED in the App Router.
 * `noindex` — a transactional, token-bearing credential page must never be indexed.
 */
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm';

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
      path: '/reset',
      title: t('reset.title'),
    }),
    robots: { index: false, follow: false },
  };
}

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth');

  return (
    <section aria-labelledby="reset-heading" className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 id="reset-heading" className="text-2xl font-bold text-foreground">
          {t('reset.title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('reset.subtitle')}</p>
      </header>
      {/* useSearchParams requires a Suspense boundary in the App Router. */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">{t('reset.subtitle')}</p>}>
        <ResetPasswordForm />
      </Suspense>
    </section>
  );
}
