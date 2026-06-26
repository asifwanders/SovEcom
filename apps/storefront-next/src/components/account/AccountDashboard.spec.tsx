import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

let customer: { name?: string | null; email: string } | null;
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ customer }),
}));

import { AccountDashboard } from './AccountDashboard';

beforeEach(() => {
  customer = { name: 'Ada Lovelace', email: 'ada@example.com' };
});

describe('AccountDashboard', () => {
  it('greets the signed-in customer by name', () => {
    renderWithIntl(<AccountDashboard />, 'en');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Ada Lovelace/);
  });

  it('falls back to the email when the customer has no name', () => {
    customer = { name: null, email: 'ada@example.com' };
    renderWithIntl(<AccountDashboard />, 'en');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/ada@example.com/);
  });

  it('offers quick links to orders, addresses and profile', () => {
    renderWithIntl(<AccountDashboard />, 'en');
    expect(screen.getByRole('link', { name: /orders/i })).toHaveAttribute(
      'href',
      '/account/orders',
    );
    expect(screen.getByRole('link', { name: /addresses/i })).toHaveAttribute(
      'href',
      '/account/addresses',
    );
    expect(screen.getByRole('link', { name: /profile/i })).toHaveAttribute(
      'href',
      '/account/profile',
    );
  });
});
