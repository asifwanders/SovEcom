import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

let auth: { isAuthenticated: boolean; isLoading: boolean };
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => auth,
}));

import { AccountLink } from './AccountLink';

describe('AccountLink (header island)', () => {
  it('links to the account area when the customer is signed in', () => {
    auth = { isAuthenticated: true, isLoading: false };
    renderWithIntl(<AccountLink />, 'en');
    expect(screen.getByRole('link', { name: /account/i })).toHaveAttribute('href', '/account');
    expect(screen.queryByRole('link', { name: /sign in/i })).not.toBeInTheDocument();
  });

  it('links to sign-in for a guest', () => {
    auth = { isAuthenticated: false, isLoading: false };
    renderWithIntl(<AccountLink />, 'en');
    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', '/login');
  });

  it('renders no link while the session is still resolving (avoids a guest flash)', () => {
    auth = { isAuthenticated: false, isLoading: true };
    renderWithIntl(<AccountLink />, 'en');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
