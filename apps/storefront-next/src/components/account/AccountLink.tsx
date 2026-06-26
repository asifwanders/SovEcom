'use client';

/**
 * Header account affordance. A small client island reading `useAuth`: a signed-in customer gets a
 * link to the account area; a guest gets a link to sign in. While the silent refresh resolves
 * (`isLoading`) it renders nothing, so a guest never flashes "Sign in" before an authenticated session
 * hydrates.
 */
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { useAuth } from '@/lib/auth-context';

export function AccountLink(): React.ReactElement | null {
  const t = useTranslations('account');
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) return null;

  return isAuthenticated ? (
    <Link href="/account" className="text-foreground transition-colors hover:text-primary">
      {t('headerAccount')}
    </Link>
  ) : (
    <Link href="/login" className="text-foreground transition-colors hover:text-primary">
      {t('headerSignIn')}
    </Link>
  );
}
