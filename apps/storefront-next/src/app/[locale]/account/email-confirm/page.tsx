/**
 * email-change CONFIRM route (`/account/email-confirm`).
 *
 * Deliberately an UNGROUPED `account/` segment (NOT under `(account)`), so the group layout's
 * `AccountGate` does NOT apply: the verification link is clicked from an email and the visitor may be
 * logged OUT, so the route must be reachable without a session. `noindex` — a transactional,
 * token-bearing page must never be indexed. The token lives only in the query and is consumed by the
 * client island; this RSC shell never touches it.
 */
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { setRequestLocale, getTranslations } from 'next-intl/server';
import { siteOrigin } from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';
import { EmailConfirmClient } from '@/components/account/EmailConfirmClient';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'account.email' });
  return {
    ...buildRouteMetadata({
      origin: siteOrigin(),
      locale,
      path: '/account/email-confirm',
      title: t('confirmTitle'),
    }),
    robots: { index: false, follow: false },
  };
}

export default async function EmailConfirmPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('account.email');

  return (
    <section aria-labelledby="email-confirm-heading" className="mx-auto max-w-2xl px-4 py-8">
      <h1 id="email-confirm-heading" className="mb-6 text-2xl font-bold text-foreground">
        {t('confirmTitle')}
      </h1>
      {/* useSearchParams requires a Suspense boundary in the App Router. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">{t('confirm.verifying')}</p>}
      >
        <EmailConfirmClient />
      </Suspense>
    </section>
  );
}
