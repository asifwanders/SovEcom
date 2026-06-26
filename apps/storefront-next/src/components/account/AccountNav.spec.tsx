import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

const replace = vi.fn();
let pathname = '/account';
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

const logout = vi.fn<() => Promise<void>>();
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ logout }),
}));

import { AccountNav } from './AccountNav';

beforeEach(() => {
  replace.mockReset();
  logout.mockReset();
  logout.mockResolvedValue();
  pathname = '/account';
});

describe('AccountNav', () => {
  it('renders every account section as a locale-relative link', () => {
    renderWithIntl(<AccountNav />, 'en');
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/account');
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
    expect(screen.getByRole('link', { name: /security/i })).toHaveAttribute(
      'href',
      '/account/security',
    );
    expect(screen.getByRole('link', { name: /privacy/i })).toHaveAttribute(
      'href',
      '/account/privacy',
    );
  });

  it('marks the current section active via aria-current and only that one', () => {
    pathname = '/account/orders';
    renderWithIntl(<AccountNav />, 'en');
    expect(screen.getByRole('link', { name: /orders/i })).toHaveAttribute('aria-current', 'page');
    // The dashboard link is an EXACT-match section — a sub-path must not light it up.
    expect(screen.getByRole('link', { name: /dashboard/i })).not.toHaveAttribute('aria-current');
  });

  it('marks the dashboard active only on the exact /account path', () => {
    pathname = '/account';
    renderWithIntl(<AccountNav />, 'en');
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: /orders/i })).not.toHaveAttribute('aria-current');
  });

  it('marks the security section active when on /account/security', () => {
    pathname = '/account/security';
    renderWithIntl(<AccountNav />, 'en');
    expect(screen.getByRole('link', { name: /security/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /dashboard/i })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: /profile/i })).not.toHaveAttribute('aria-current');
  });

  it('marks the privacy section active when on /account/privacy', () => {
    pathname = '/account/privacy';
    renderWithIntl(<AccountNav />, 'en');
    expect(screen.getByRole('link', { name: /privacy/i })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /security/i })).not.toHaveAttribute('aria-current');
  });

  it('signs out and returns to the home page', async () => {
    renderWithIntl(<AccountNav />, 'en');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    });
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith('/');
  });
});
