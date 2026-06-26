import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// Mock the i18n + next navigation the footer's LanguageSwitcher consumes.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => '/products',
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(''),
}));
// The footer's "Manage cookies" button reads the consent context; stub it for this unit.
vi.mock('@/lib/consent', () => ({ useConsent: () => ({ openManage: vi.fn() }) }));

import { Footer } from './Footer';

afterEach(() => {
  document.documentElement.classList.remove('dark');
  document.cookie = 'theme=; path=/; max-age=0';
});

describe('Footer', () => {
  it('renders the rights line, legal + browse links (EN)', () => {
    renderWithIntl(<Footer />, 'en');
    expect(screen.getByText(/SovEcom\. EU-first/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: 'Products' })).toHaveAttribute('href', '/products');
    expect(screen.getByRole('button', { name: 'Manage cookies' })).toBeInTheDocument();
  });

  it('hosts the LanguageSwitcher and the dark-mode ThemeToggle', () => {
    renderWithIntl(<Footer />, 'en');
    expect(screen.getByRole('combobox', { name: 'Language' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mode/i })).toBeInTheDocument();
  });

  it('localizes the footer links nav label in French', () => {
    renderWithIntl(<Footer />, 'fr');
    expect(screen.getByRole('navigation', { name: 'Pied de page' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Confidentialité' })).toBeInTheDocument();
  });
});
