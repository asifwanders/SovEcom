import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

/**
 * The `/products` PLP sections (flat template). Asserts the header h1, the grid (or empty state),
 * and the cursor "Load more" link parity — including the locale-prefixed `?cursor=` href and the
 * page's gating (no link without a nextCursor / no products).
 */
const fetchProducts = vi.fn();
// The per-card `product-card-actions` slot is rendered by an async `<Slot>` RSC.
// These tests render the grid SYNCHRONOUSLY, so stub the provider to the no-module-bound default
// (renders nothing — DOM byte-identical to the baseline). The per-card slot's own rendering
// is covered by ProductCard.slot.spec.tsx + Slot.spec.tsx + the Playwright slot e2e.
vi.mock('@/components/cardActions', () => ({
  productCardActions: () => null,
}));
vi.mock('@/lib/catalog', () => ({
  fetchProducts: (...a: unknown[]) => fetchProducts(...a),
}));

import {
  ProductsHeaderSection,
  ProductsGridSection,
  ProductsLoadMoreSection,
} from './ProductsSections';

const ctx = (searchParams: Record<string, string> = {}) => ({ locale: 'en', searchParams });

beforeEach(() => {
  fetchProducts.mockReset();
  fetchProducts.mockResolvedValue({ products: [], nextCursor: null });
});

describe('ProductsHeaderSection', () => {
  it('renders the localized h1 with parity classes', async () => {
    const node = await ProductsHeaderSection.Component({
      settings: {},
      data: undefined,
      locale: 'en',
    });
    renderWithIntl(<>{node}</>, 'en');
    const h1 = screen.getByRole('heading', { level: 1, name: 'Products' });
    expect(h1).toHaveClass('text-2xl', 'font-semibold', 'mb-6');
  });
});

describe('ProductsGridSection', () => {
  it('forwards the ?cursor= param to fetchProducts + renders the grid', async () => {
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
    const data = await ProductsGridSection.loader!({}, ctx({ cursor: 'PREV==' }));
    expect(fetchProducts).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'PREV==' }));
    const node = await ProductsGridSection.Component({ settings: {}, data, locale: 'en' });
    renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByText('Cotton Tee')).toBeInTheDocument();
    expect(screen.getByText(/25[.,]00/)).toBeInTheDocument();
  });

  it('renders the empty state with no products', async () => {
    const data = await ProductsGridSection.loader!({}, ctx());
    const node = await ProductsGridSection.Component({ settings: {}, data, locale: 'en' });
    renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByText('No products found.')).toBeInTheDocument();
  });
});

describe('ProductsLoadMoreSection', () => {
  it('renders a locale-prefixed Load more link when a nextCursor exists', async () => {
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
    const data = await ProductsLoadMoreSection.loader!({}, ctx());
    const node = await ProductsLoadMoreSection.Component({ settings: {}, data, locale: 'en' });
    renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByRole('link', { name: 'Load more' })).toHaveAttribute(
      'href',
      '/en/products?cursor=NEXT%3D%3D',
    );
  });

  it('renders nothing when there is no nextCursor', async () => {
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
      nextCursor: null,
    });
    const data = await ProductsLoadMoreSection.loader!({}, ctx());
    const node = await ProductsLoadMoreSection.Component({ settings: {}, data, locale: 'en' });
    const { container } = renderWithIntl(<>{node}</>, 'en');
    expect(container).toBeEmptyDOMElement();
  });
});
