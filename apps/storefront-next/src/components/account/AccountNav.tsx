'use client';

/**
 * customer account section nav. A client island: it reads
 * the current `usePathname` to mark the active section (`aria-current="page"`) and renders the sign-out
 * action. Locale-aware `Link`s (next-intl) so each target is prefixed with the active locale.
 *
 * The dashboard is an EXACT-match section (`/account`); the others match their path or any sub-path
 * (e.g. `/account/orders/123` keeps "Orders" active). RTL-safe: logical spacing + `text-start` only.
 */
import { useTranslations } from 'next-intl';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { markSigningOut } from '@/lib/account-session';

const SECTIONS = [
  { key: 'dashboard', href: '/account', exact: true },
  { key: 'orders', href: '/account/orders', exact: false },
  { key: 'addresses', href: '/account/addresses', exact: false },
  { key: 'profile', href: '/account/profile', exact: false },
  { key: 'security', href: '/account/security', exact: false },
  { key: 'privacy', href: '/account/privacy', exact: false },
] as const;

export function AccountNav(): React.ReactElement {
  const t = useTranslations('account');
  const pathname = usePathname();
  const router = useRouter();
  const { logout } = useAuth();

  function isActive(href: string, exact: boolean): boolean {
    return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  }

  async function onSignOut(): Promise<void> {
    // Flag the intentional sign-out so the gate skips its login redirect, then revoke. `logout()`
    // never rejects (it clears the in-memory token in a `finally`), but guard + `finally` so the
    // navigation home is guaranteed even if that ever changes.
    markSigningOut();
    try {
      await logout();
    } finally {
      router.replace('/');
    }
  }

  return (
    <nav aria-label={t('navHeading')} className="flex flex-col gap-1">
      {SECTIONS.map(({ key, href, exact }) => {
        const active = isActive(href, exact);
        return (
          <Link
            key={key}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-2 text-sm transition-colors ${
              active
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            }`}
          >
            {t(`nav.${key}`)}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onSignOut}
        className="mt-2 rounded-md px-3 py-2 text-start text-sm text-muted-foreground transition-colors hover:text-destructive"
      >
        {t('nav.signOut')}
      </button>
    </nav>
  );
}
