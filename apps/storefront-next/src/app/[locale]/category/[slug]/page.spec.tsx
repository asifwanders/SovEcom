import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

const fetchCategoryBySlug = vi.fn();
const fetchSearch = vi.fn();
// The per-card `product-card-actions` slot is rendered by an async `<Slot>` RSC.
// These tests render the grid SYNCHRONOUSLY, so stub the provider to the no-module-bound default
// (renders nothing — DOM byte-identical to before activation). The per-card slot's own rendering
// is covered by ProductCard.slot.spec.tsx + Slot.spec.tsx + the Playwright slot e2e.
vi.mock('@/components/cardActions', () => ({
  productCardActions: () => null,
}));
vi.mock('@/lib/catalog', () => ({
  fetchCategoryBySlug: (...a: unknown[]) => fetchCategoryBySlug(...a),
  fetchSearch: (...a: unknown[]) => fetchSearch(...a),
}));

// The page resolves the active theme NAME to pick the section template-set. Mock it explicitly
// (match the product page spec) so the template resolves to the bundled `default` set, rather than
// relying on the fetch's error-swallow.
vi.mock('@/lib/theme', () => ({
  fetchActiveTheme: vi.fn(async () => null),
}));

// notFound() throws a sentinel we can assert on (mirrors Next's control-flow throw). Keep the rest
// of next/navigation REAL via importOriginal — next-intl's createNavigation (pulled in transitively
// by ProductGrid → i18n/navigation) needs `redirect`/`permanentRedirect` to exist at module load.
// Also stub `useSearchParams` for the client `FilterSidebar` the page now renders.
const NOT_FOUND = new Error('NEXT_NOT_FOUND');
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  notFound: () => {
    throw NOT_FOUND;
  },
  useSearchParams: () => new URLSearchParams(''),
}));

// The page renders the client `FilterSidebar` (URL-state via these i18n navigation hooks). Keep the
// real `Link`/`redirect` (ProductGrid/Pagination/Breadcrumbs render locale-aware links) and override
// only the `usePathname`/`useRouter` the FilterSidebar reads.
vi.mock('@/i18n/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/i18n/navigation')>()),
  usePathname: () => '/category/apparel',
  useRouter: () => ({ replace: vi.fn() }),
}));

const EMPTY_FACETS = { categories: [], price: null };

import CategoryPage from './page';

function props(slug: string, sort?: string, page?: string, locale: 'en' | 'fr' = 'en') {
  const sp: { sort?: string; page?: string } = {};
  if (sort) sp.sort = sort;
  if (page !== undefined) sp.page = page;
  return {
    params: Promise.resolve({ locale, slug }),
    searchParams: Promise.resolve(sp),
  };
}

function category() {
  return { id: 'c1', slug: 'apparel', name: 'Apparel', parentId: null, children: [] };
}

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
  fetchCategoryBySlug.mockReset();
  fetchSearch.mockReset();
  fetchSearch.mockResolvedValue({ products: [], total: 0, facets: EMPTY_FACETS });
});

describe('CategoryPage', () => {
  it('renders the category name + its products with prices', async () => {
    fetchCategoryBySlug.mockResolvedValue(category());
    fetchSearch.mockResolvedValue({
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
      total: 1,
      facets: EMPTY_FACETS,
    });
    renderWithIntl(await CategoryPage(props('apparel')));
    expect(screen.getByRole('heading', { name: 'Apparel' })).toBeInTheDocument();
    expect(screen.getByText('Cotton Tee')).toBeInTheDocument();
    expect(screen.getByText(/25[.,]00/)).toBeInTheDocument();
  });

  it('composes the verbatim header row (h1 + sort) ABOVE the columns sidebar grid', async () => {
    fetchCategoryBySlug.mockResolvedValue(category());
    fetchSearch.mockResolvedValue({ products: manyProducts(1), total: 1, facets: EMPTY_FACETS });
    const { container } = renderWithIntl(await CategoryPage(props('apparel', 'price_asc')));

    // The single `justify-between` header row holds BOTH the h1 AND the sort form/select (the
    // regression the earlier header/sort split introduced — now consolidated into `category-header-row`).
    const row = container.querySelector(
      'div.flex.flex-col.sm\\:flex-row.sm\\:items-center.sm\\:justify-between.gap-4.mb-6',
    );
    expect(row).not.toBeNull();
    expect(row!.querySelector('h1')).toHaveTextContent('Apparel');
    expect(row!.querySelector('form select[name="sort"]')).not.toBeNull();

    // The `columns` layout primitive renders the verbatim sidebar-grid + results column.
    const grid = container.querySelector('div.flex.flex-col.gap-8.sm\\:flex-row');
    expect(grid).not.toBeNull();
    const results = container.querySelector('div.min-w-0.flex-1');
    expect(results).not.toBeNull();

    // The result-count <p> (mb-4) is INSIDE the results column, NOT in the header row.
    expect(results!.querySelector('p.text-sm.text-muted-foreground.mb-4')).not.toBeNull();
    expect(row!.querySelector('p.text-sm.text-muted-foreground.mb-4')).toBeNull();

    // The header row is a SIBLING above the sidebar grid (not nested inside it).
    expect(grid!.contains(row!)).toBe(false);

    // The outer page container is still page-level (parity).
    expect(container.querySelector('div.mx-auto.max-w-6xl.px-4.py-8')).not.toBeNull();
  });

  it('renders French sort labels + empty state when locale=fr', async () => {
    fetchCategoryBySlug.mockResolvedValue(category());
    renderWithIntl(await CategoryPage(props('apparel', undefined, undefined, 'fr')), 'fr');
    expect(screen.getByText('Aucun produit dans cette catégorie.')).toBeInTheDocument();
    expect(screen.getByText('Appliquer')).toBeInTheDocument();
  });

  it('lists products for the category via search by slug (single-language fetch)', async () => {
    fetchCategoryBySlug.mockResolvedValue(category());
    await CategoryPage(props('apparel', 'price_asc'));
    expect(fetchSearch).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'apparel', sort: 'price_asc' }),
    );
    // Catalog fetch is NOT locale-aware — no `locale` key in the search args.
    expect(fetchSearch.mock.calls[0]![0]).not.toHaveProperty('locale');
  });

  it('renders an empty state when the category has no products (EN)', async () => {
    fetchCategoryBySlug.mockResolvedValue(category());
    renderWithIntl(await CategoryPage(props('apparel')));
    expect(screen.getByText('No products in this category.')).toBeInTheDocument();
  });

  it('calls notFound() for an unknown slug (404)', async () => {
    fetchCategoryBySlug.mockResolvedValue(null);
    await expect(CategoryPage(props('nope'))).rejects.toBe(NOT_FOUND);
  });

  it('defaults to page 1 and hides "Previous" on the first page', async () => {
    fetchCategoryBySlug.mockResolvedValue(category());
    // 50 total, pageSize 24 → page 1 has a Next but no Previous.
    fetchSearch.mockResolvedValue({ products: manyProducts(24), total: 50, facets: EMPTY_FACETS });
    renderWithIntl(await CategoryPage(props('apparel')));
    expect(fetchSearch).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'apparel', page: 1 }),
    );
    expect(screen.queryByRole('link', { name: 'Previous' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Next' })).toBeInTheDocument();
  });

  it('requests page 2 and renders both Previous and Next with locale-prefixed slug/sort', async () => {
    fetchCategoryBySlug.mockResolvedValue(category());
    // 80 total, pageSize 24 → page 2 (items 25-48) has both Previous and Next.
    fetchSearch.mockResolvedValue({ products: manyProducts(24), total: 80, facets: EMPTY_FACETS });
    renderWithIntl(await CategoryPage(props('apparel', 'price_asc', '2')));
    expect(fetchSearch).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'apparel', sort: 'price_asc', page: 2 }),
    );
    const prev = screen.getByRole('link', { name: 'Previous' });
    const next = screen.getByRole('link', { name: 'Next' });
    expect(prev).toHaveAttribute('href', expect.stringContaining('/en/category/apparel'));
    expect(prev).toHaveAttribute('href', expect.stringContaining('page=1'));
    expect(prev).toHaveAttribute('href', expect.stringContaining('sort=price_asc'));
    expect(next).toHaveAttribute('href', expect.stringContaining('page=3'));
    expect(next).toHaveAttribute('href', expect.stringContaining('sort=price_asc'));
  });

  it('hides "Next" on the last page', async () => {
    fetchCategoryBySlug.mockResolvedValue(category());
    // 50 total, pageSize 24 → last page is 3 (items 49-50): Previous only.
    fetchSearch.mockResolvedValue({ products: manyProducts(2), total: 50, facets: EMPTY_FACETS });
    renderWithIntl(await CategoryPage(props('apparel', undefined, '3')));
    expect(fetchSearch).toHaveBeenCalledWith(expect.objectContaining({ page: 3 }));
    expect(screen.getByRole('link', { name: 'Previous' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull();
  });

  it('clamps garbage / out-of-range page to 1', async () => {
    fetchCategoryBySlug.mockResolvedValue(category());
    fetchSearch.mockResolvedValue({ products: manyProducts(24), total: 50, facets: EMPTY_FACETS });
    renderWithIntl(await CategoryPage(props('apparel', undefined, 'abc')));
    expect(fetchSearch).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
  });
});
