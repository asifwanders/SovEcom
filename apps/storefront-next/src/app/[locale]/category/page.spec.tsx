import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

const fetchCategoryTree = vi.fn();
vi.mock('@/lib/catalog', () => ({
  fetchCategoryTree: (...a: unknown[]) => fetchCategoryTree(...a),
}));

import CategoryIndexPage from './page';

const props = (locale: 'en' | 'fr' = 'en') => ({ params: Promise.resolve({ locale }) });

beforeEach(() => {
  fetchCategoryTree.mockReset();
  fetchCategoryTree.mockResolvedValue([]);
});

describe('CategoryIndexPage', () => {
  it('renders locale-prefixed category links into each PLP', async () => {
    fetchCategoryTree.mockResolvedValue([
      {
        id: 'c1',
        slug: 'apparel',
        name: 'Apparel',
        parentId: null,
        children: [{ id: 'c2', slug: 'tees', name: 'Tees', parentId: 'c1', children: [] }],
      },
    ]);
    renderWithIntl(await CategoryIndexPage(props('en')), 'en');
    expect(screen.getByRole('link', { name: 'Apparel' })).toHaveAttribute(
      'href',
      '/en/category/apparel',
    );
    expect(screen.getByRole('link', { name: 'Tees' })).toHaveAttribute('href', '/en/category/tees');
  });

  it('renders an empty state with no categories (EN)', async () => {
    renderWithIntl(await CategoryIndexPage(props('en')), 'en');
    expect(screen.getByText('No categories found.')).toBeInTheDocument();
  });

  it('renders the localized title in French', async () => {
    renderWithIntl(await CategoryIndexPage(props('fr')), 'fr');
    expect(screen.getByRole('heading', { name: 'Catégories' })).toBeInTheDocument();
    expect(screen.getByText('Aucune catégorie trouvée.')).toBeInTheDocument();
  });
});
