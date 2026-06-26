import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

const fetchProducts = vi.fn();
// The per-card `product-card-actions` slot is rendered by an async `<Slot>` RSC.
// These tests render the grid SYNCHRONOUSLY, so stub the provider to the no-module-bound default
// (renders nothing — DOM byte-identical to before activation). The per-card slot's own rendering
// is covered by ProductCard.slot.spec.tsx + Slot.spec.tsx + the Playwright slot e2e.
vi.mock('@/components/cardActions', () => ({
  productCardActions: () => null,
}));
vi.mock('@/lib/catalog', () => ({
  fetchProducts: (...a: unknown[]) => fetchProducts(...a),
}));

// The page resolves the active theme NAME to pick the section template-set. Mock it explicitly
// (match the product page spec) so the template resolves to the bundled `default` set.
vi.mock('@/lib/theme', () => ({
  fetchActiveTheme: vi.fn(async () => null),
}));

import ProductsPage from './page';

const props = (cursor?: string, locale: 'en' | 'fr' = 'en') => ({
  params: Promise.resolve({ locale }),
  searchParams: Promise.resolve(cursor ? { cursor } : {}),
});

beforeEach(() => {
  fetchProducts.mockReset();
  fetchProducts.mockResolvedValue({ products: [], nextCursor: null });
});

describe('ProductsPage', () => {
  it('renders products with prices via formatPrice', async () => {
    fetchProducts.mockResolvedValue({
      products: [
        {
          id: 'p1',
          slug: 'tee',
          title: 'Cotton Tee',
          thumbnailUrl: null,
          priceAmount: 2500,
          currency: 'EUR',
        },
      ],
      nextCursor: null,
    });
    renderWithIntl(await ProductsPage(props()));
    expect(screen.getByText('Cotton Tee')).toBeInTheDocument();
    expect(screen.getByText(/25[.,]00/)).toBeInTheDocument();
  });

  it('renders an empty state with no products (EN)', async () => {
    const { container } = renderWithIntl(await ProductsPage(props()));
    expect(screen.getByText('No products found.')).toBeInTheDocument();
    // No `columns` sidebar grid on /products.
    expect(container.querySelector('div.flex.flex-col.gap-8.sm\\:flex-row')).toBeNull();
    // The outer page container stays page-level (parity).
    expect(container.querySelector('div.mx-auto.max-w-6xl.px-4.py-8')).not.toBeNull();
  });

  it('renders French chrome when locale=fr', async () => {
    renderWithIntl(await ProductsPage(props(undefined, 'fr')), 'fr');
    expect(screen.getByRole('heading', { name: 'Produits' })).toBeInTheDocument();
    expect(screen.getByText('Aucun produit trouvé.')).toBeInTheDocument();
  });

  it('forwards the cursor param and renders a locale-prefixed Load more link', async () => {
    fetchProducts.mockResolvedValue({
      products: [
        {
          id: 'p1',
          slug: 'tee',
          title: 'Tee',
          thumbnailUrl: null,
          priceAmount: null,
          currency: null,
        },
      ],
      nextCursor: 'NEXT==',
    });
    renderWithIntl(await ProductsPage(props('PREV==')));
    expect(fetchProducts).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'PREV==' }));
    expect(screen.getByRole('link', { name: 'Load more' })).toHaveAttribute(
      'href',
      '/en/products?cursor=NEXT%3D%3D',
    );
  });
});
