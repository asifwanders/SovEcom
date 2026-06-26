'use client';

/**
 * Customer account dashboard. A client island reading the
 * in-memory `useAuth().customer` (it only renders inside the authenticated `AccountGate` subtree). It
 * greets the customer and offers quick links into the account sections.
 */
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';

const CARDS = [
  { key: 'orders', href: '/account/orders' },
  { key: 'addresses', href: '/account/addresses' },
  { key: 'profile', href: '/account/profile' },
] as const;

export function AccountDashboard(): React.ReactElement {
  const t = useTranslations('account.dashboard');
  const { customer } = useAuth();
  // Prefer the display name; fall back to the email so the greeting is never empty.
  const displayName = customer?.name?.trim() || customer?.email || '';

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold text-foreground">
          {displayName ? t('welcome', { name: displayName }) : t('title')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map(({ key, href }) => (
          <Link
            key={key}
            href={href}
            className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary"
          >
            <span className="font-medium text-foreground">{t(`${key}CardTitle`)}</span>
            <span className="text-sm text-muted-foreground">{t(`${key}CardDesc`)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
