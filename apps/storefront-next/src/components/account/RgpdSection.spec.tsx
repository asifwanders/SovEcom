/**
 * RgpdSection wrapper tests.
 *
 * The section composes the export + erase sub-components under a single "Your data & privacy" heading.
 * The two children own their own behaviour (covered in RgpdExport.spec / RgpdErase.spec); here we only
 * assert the wrapper renders the heading and both affordances, in EN and FR.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

const CUSTOMER = { id: 'c1', email: 'ada@example.com', name: 'Ada Lovelace' };

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({
    customer: CUSTOMER,
    getAccessToken: () => 'token-abc',
    refresh: async () => 'token-abc',
    logout: vi.fn(),
  }),
}));

vi.mock('@/lib/browser-client', () => ({
  createBrowserClient: () => ({ request: async () => undefined }),
}));

vi.mock('@/lib/account-session', () => ({ markSigningOut: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

import { RgpdSection } from './RgpdSection';

beforeEach(() => {
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
});

describe('RgpdSection', () => {
  it('renders the section heading and both export + erase affordances (EN)', () => {
    renderWithIntl(<RgpdSection />, 'en');
    expect(screen.getByText(/your data & privacy/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export my data/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /permanently delete my account/i }),
    ).toBeInTheDocument();
  });

  it('renders the section heading (FR)', () => {
    renderWithIntl(<RgpdSection />, 'fr');
    expect(screen.getByText(/vos données et votre vie privée/i)).toBeInTheDocument();
  });
});
