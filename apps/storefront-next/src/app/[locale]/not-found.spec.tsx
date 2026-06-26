import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// Stub the locale-aware Link to a plain anchor for the unit test.
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} {...rest}>
      {children}
    </a>
  ),
}));

import NotFound from './not-found';

describe('storefront NotFound', () => {
  it('renders the on-brand 404 with a link back to the catalog (EN)', () => {
    renderWithIntl(<NotFound />, 'en');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Back to products' });
    expect(link).toHaveAttribute('href', '/products');
  });

  it('renders localized French copy', () => {
    renderWithIntl(<NotFound />, 'fr');
    expect(screen.getByRole('heading', { name: 'Page introuvable' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retour aux produits' })).toBeInTheDocument();
  });
});
