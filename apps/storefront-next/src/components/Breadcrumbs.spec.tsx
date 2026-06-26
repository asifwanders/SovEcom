import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import { Breadcrumbs } from './Breadcrumbs';

const trail = [
  { label: 'Apparel', href: '/category/apparel' },
  { label: 'Cotton Tee', href: '/product/tee' },
];

describe('Breadcrumbs', () => {
  it('renders a nav with the localized aria-label and an ordered list', () => {
    renderWithIntl(<Breadcrumbs items={trail} />, 'en');
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav).toBeInTheDocument();
    // Semantic ordered list.
    expect(within(nav).getByRole('list').tagName).toBe('OL');
  });

  it('prepends a localized Home root linking to the locale-prefixed home', () => {
    renderWithIntl(<Breadcrumbs items={trail} />, 'en');
    const home = screen.getByRole('link', { name: 'Home' });
    expect(home).toHaveAttribute('href', '/en');
  });

  it('links every crumb except the last; intermediate crumbs are locale-prefixed', () => {
    renderWithIntl(<Breadcrumbs items={trail} />, 'en');
    expect(screen.getByRole('link', { name: 'Apparel' })).toHaveAttribute(
      'href',
      '/en/category/apparel',
    );
  });

  it('marks the LAST crumb as the current page with no link', () => {
    renderWithIntl(<Breadcrumbs items={trail} />, 'en');
    // The leaf is plain text, not a link.
    expect(screen.queryByRole('link', { name: 'Cotton Tee' })).toBeNull();
    const current = screen.getByText('Cotton Tee');
    expect(current).toHaveAttribute('aria-current', 'page');
  });

  it('renders the Home root + aria-label in French', () => {
    renderWithIntl(<Breadcrumbs items={trail} />, 'fr');
    expect(screen.getByRole('navigation', { name: 'Fil d’Ariane' })).toBeInTheDocument();
    const home = screen.getByRole('link', { name: 'Accueil' });
    expect(home).toHaveAttribute('href', '/fr');
  });

  it('the data shape is { label, href }[] — ready for BreadcrumbList JSON-LD', () => {
    // A single-item trail still renders Home + the (current) leaf; proves the array drives the trail.
    renderWithIntl(<Breadcrumbs items={[{ label: 'Cotton Tee', href: '/product/tee' }]} />, 'en');
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByText('Cotton Tee')).toHaveAttribute('aria-current', 'page');
  });
});
