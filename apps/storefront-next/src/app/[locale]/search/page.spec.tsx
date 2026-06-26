import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

const fetchSearch = vi.fn();
// The per-card `product-card-actions` slot is rendered by an async `<Slot>` RSC.
// These tests render the grid SYNCHRONOUSLY, so stub the provider to the no-module-bound default
// (renders nothing — DOM byte-identical to before activation). The per-card slot's own rendering
// is covered by ProductCard.slot.spec.tsx + Slot.spec.tsx + the Playwright slot e2e.
vi.mock('@/components/cardActions', () => ({
  productCardActions: () => null,
}));
vi.mock('@/lib/catalog', () => ({
  fetchSearch: (...a: unknown[]) => fetchSearch(...a),
}));

// The page resolves the active theme NAME to pick the section template-set. Mock it explicitly
// (match the product page spec) so the template resolves to the bundled `default` set.
vi.mock('@/lib/theme', () => ({
  fetchActiveTheme: vi.fn(async () => null),
}));

// The page now renders the client `FilterSidebar`, which reads URL-state via these navigation hooks.
// Keep the real `Link` (Pagination/ProductCard render locale-aware links) and override only the
// `usePathname`/`useRouter` the FilterSidebar reads.
vi.mock('@/i18n/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/i18n/navigation')>()),
  usePathname: () => '/search',
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(''),
}));

const EMPTY_FACETS = { categories: [], price: null };

import SearchPage from './page';

const props = (q?: string, page?: string, locale: 'en' | 'fr' = 'en') => {
  const sp: { q?: string; page?: string } = {};
  if (q !== undefined) sp.q = q;
  if (page !== undefined) sp.page = page;
  return { params: Promise.resolve({ locale }), searchParams: Promise.resolve(sp) };
};

function manyProducts(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    slug: `s${i}`,
    title: `Product ${i}`,
    thumbnailUrl: null,
    priceAmount: 1000,
    currency: 'EUR',
  }));
}

beforeEach(() => {
  fetchSearch.mockReset();
  fetchSearch.mockResolvedValue({ products: [], total: 0, facets: EMPTY_FACETS });
});

describe('SearchPage', () => {
  it('renders results for a query with prices via formatPrice', async () => {
    fetchSearch.mockResolvedValue({
      products: [
        {
          id: 'p1',
          slug: 'tee',
          title: 'Cotton Tee',
          thumbnailUrl: null,
          priceAmount: 1999,
          currency: 'EUR',
        },
      ],
      total: 1,
      facets: EMPTY_FACETS,
    });
    renderWithIntl(await SearchPage(props('tee')));
    expect(screen.getByText('Cotton Tee')).toBeInTheDocument();
    expect(screen.getByText(/19[.,]99/)).toBeInTheDocument();
    expect(fetchSearch).toHaveBeenCalledWith(expect.objectContaining({ q: 'tee' }));
  });

  it('renders a prompt and does NOT fetch for an empty query (EN)', async () => {
    const { container } = renderWithIntl(await SearchPage(props('')));
    expect(screen.getByText('Enter a search term to find products.')).toBeInTheDocument();
    expect(fetchSearch).not.toHaveBeenCalled();
    // Empty-`q` branch stays PAGE-LEVEL: no `columns` sidebar grid is composed.
    expect(container.querySelector('div.flex.flex-col.gap-8.sm\\:flex-row')).toBeNull();
  });

  it('composes the body from the search template (columns sidebar grid) for a query', async () => {
    fetchSearch.mockResolvedValue({ products: manyProducts(1), total: 1, facets: EMPTY_FACETS });
    const { container } = renderWithIntl(await SearchPage(props('tee')));
    // The search `<form>` + heading stay page-level; the results body is the `columns` layout.
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(container.querySelector('div.flex.flex-col.gap-8.sm\\:flex-row')).not.toBeNull();
    expect(container.querySelector('div.min-w-0.flex-1')).not.toBeNull();
  });

  it('renders the French prompt when locale=fr', async () => {
    renderWithIntl(await SearchPage(props('', undefined, 'fr')), 'fr');
    expect(
      screen.getByText('Saisissez un terme de recherche pour trouver des produits.'),
    ).toBeInTheDocument();
  });

  it('renders a no-results state for a query with no hits', async () => {
    renderWithIntl(await SearchPage(props('zzz')));
    expect(screen.getByText(/No results found/)).toBeInTheDocument();
  });

  it('defaults to page 1 and hides "Previous" on the first page', async () => {
    fetchSearch.mockResolvedValue({ products: manyProducts(24), total: 50, facets: EMPTY_FACETS });
    renderWithIntl(await SearchPage(props('tee')));
    expect(fetchSearch).toHaveBeenCalledWith(expect.objectContaining({ q: 'tee', page: 1 }));
    expect(screen.queryByRole('link', { name: 'Previous' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Next' })).toBeInTheDocument();
  });

  it('requests page 2 and renders both Previous and Next, preserving q', async () => {
    fetchSearch.mockResolvedValue({ products: manyProducts(24), total: 80, facets: EMPTY_FACETS });
    renderWithIntl(await SearchPage(props('tee', '2')));
    expect(fetchSearch).toHaveBeenCalledWith(expect.objectContaining({ q: 'tee', page: 2 }));
    const prev = screen.getByRole('link', { name: 'Previous' });
    const next = screen.getByRole('link', { name: 'Next' });
    expect(prev).toHaveAttribute('href', expect.stringContaining('/en/search'));
    expect(prev).toHaveAttribute('href', expect.stringContaining('page=1'));
    expect(prev).toHaveAttribute('href', expect.stringContaining('q=tee'));
    expect(next).toHaveAttribute('href', expect.stringContaining('page=3'));
    expect(next).toHaveAttribute('href', expect.stringContaining('q=tee'));
  });

  it('hides "Next" on the last page', async () => {
    fetchSearch.mockResolvedValue({ products: manyProducts(2), total: 50, facets: EMPTY_FACETS });
    renderWithIntl(await SearchPage(props('tee', '3')));
    expect(fetchSearch).toHaveBeenCalledWith(expect.objectContaining({ page: 3 }));
    expect(screen.getByRole('link', { name: 'Previous' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull();
  });

  it('clamps garbage / out-of-range page to 1', async () => {
    fetchSearch.mockResolvedValue({ products: manyProducts(24), total: 50, facets: EMPTY_FACETS });
    renderWithIntl(await SearchPage(props('tee', 'abc')));
    expect(fetchSearch).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
  });
});
