'use client';

/**
 * customer account auth gate. AUTH/PII-CRITICAL.
 *
 * Wraps the whole `(account)` route group. While the in-memory session resolves (`isLoading`) it
 * shows a neutral status; once resolved, a guest is redirected to the login page (carrying a SAFE,
 * encoded `returnTo` so they bounce back after signing in) and the protected subtree is NOT rendered
 * — so none of the account pages' customer-PII fetches fire for an unauthenticated visitor.
 *
 * This is defence-in-depth UI ONLY. The real authority is server-side: every `/store/v1/customers/me/*`
 * and `/store/v1/orders` endpoint is `CustomerAuthGuard`-protected and IDOR-scoped to the principal,
 * regardless of what the client renders. NO Server Actions — the redirect is client-side.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';
import { consumeSigningOut } from '@/lib/account-session';

export function AccountGate({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement | null {
  const t = useTranslations('account');
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      // An intentional sign-out also flips us to "guest" — but `AccountNav` navigates home itself, so
      // skip the login redirect (one-shot flag) to avoid racing it to two different destinations.
      if (consumeSigningOut()) return;
      // `usePathname` is locale-STRIPPED; the locale-aware router re-prefixes the active locale. We
      // pass an encoded, root-relative path that the login page validates via `safeReturnTo` (the
      // open-redirect guard) before bouncing the customer back here.
      router.replace(`/login?returnTo=${encodeURIComponent(pathname)}`);
    }
  }, [isLoading, isAuthenticated, pathname, router]);

  if (isLoading) {
    return (
      <div role="status" aria-live="polite" className="py-12 text-sm text-muted-foreground">
        {t('loading')}
      </div>
    );
  }

  // Guest: render nothing protected while the redirect effect runs (no PII fetch downstream).
  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
