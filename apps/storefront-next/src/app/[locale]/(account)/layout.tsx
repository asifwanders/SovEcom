/**
 * `(account)` route-group layout. RSC shell that wraps
 * every account page in the client `AccountGate` (auth redirect + loading) and renders the section nav
 * beside the page content. No server data fetch here — the gate + page islands own the customer data.
 *
 * Logical CSS only (`mx-auto`, grid gap) → RTL-ready. The account pages are private; they are
 * marked `noindex` per-page via metadata.
 */
import type { ReactNode } from 'react';
import { setRequestLocale } from 'next-intl/server';
import type { Locale } from '@/i18n/routing';
import { AccountGate } from '@/components/account/AccountGate';
import { AccountNav } from '@/components/account/AccountNav';

export default async function AccountLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: Locale }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <AccountGate>
        <div className="grid gap-8 md:grid-cols-[12rem_1fr]">
          {/* AccountNav renders its own labelled <nav> landmark — no extra wrapper needed. */}
          <AccountNav />
          <div>{children}</div>
        </div>
      </AccountGate>
    </div>
  );
}
