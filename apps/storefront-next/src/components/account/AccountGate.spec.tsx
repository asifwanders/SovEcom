import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// Locale-aware navigation mock (mirror LoginForm.spec convention). `usePathname` returns the
// locale-STRIPPED current path (next-intl behaviour), which the gate echoes into `returnTo`.
const replace = vi.fn();
let pathname = '/account';
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
}));

// Drive the auth state per test.
let auth: { isAuthenticated: boolean; isLoading: boolean };
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => auth,
}));

import { AccountGate } from './AccountGate';
import { markSigningOut } from '@/lib/account-session';

beforeEach(() => {
  replace.mockReset();
  pathname = '/account';
});

describe('AccountGate', () => {
  it('shows a loading status and renders NO protected content while the session resolves', () => {
    auth = { isAuthenticated: false, isLoading: true };
    renderWithIntl(
      <AccountGate>
        <p>secret orders</p>
      </AccountGate>,
      'en',
    );
    expect(screen.getByRole('status')).toBeInTheDocument();
    // Defence-in-depth: the protected subtree (which would fetch PII) must not render pre-auth.
    expect(screen.queryByText('secret orders')).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects a guest to login with a safe, encoded returnTo and renders no protected content', async () => {
    auth = { isAuthenticated: false, isLoading: false };
    pathname = '/account/orders';
    renderWithIntl(
      <AccountGate>
        <p>secret orders</p>
      </AccountGate>,
      'en',
    );
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('/login?returnTo=%2Faccount%2Forders'),
    );
    expect(screen.queryByText('secret orders')).not.toBeInTheDocument();
  });

  it('renders protected content for an authenticated customer without redirecting', () => {
    auth = { isAuthenticated: true, isLoading: false };
    renderWithIntl(
      <AccountGate>
        <p>secret orders</p>
      </AccountGate>,
      'en',
    );
    expect(screen.getByText('secret orders')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('does NOT redirect to login when the guest transition is an intentional sign-out', async () => {
    // AccountNav raises this flag right before logout(); the gate must consume it and let the
    // sign-out navigation home win instead of racing it to /login.
    markSigningOut();
    auth = { isAuthenticated: false, isLoading: false };
    renderWithIntl(
      <AccountGate>
        <p>secret orders</p>
      </AccountGate>,
      'en',
    );
    // Give the effect a tick; it must NOT have issued a login redirect.
    await Promise.resolve();
    expect(replace).not.toHaveBeenCalled();
  });
});
