import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

/**
 * The category PLP sections. Asserts each loader reads the route slug +
 * searchParams (via the shared cached `fetchSearch`), each component reproduces the markup
 * correctly, and the SortControl + Pagination carry the right params (sort preserved, price
 * preserved, page reset on a sort change). The `category-header-row` renders the single
 * `justify-between` row (h1 + sort); `category-results` renders the results column (count <p>
 * INSIDE it, only when non-empty).
 */
const fetchCategoryBySlug = vi.fn();
const fetchSearch = vi.fn();
// The per-card `product-card-actions` slot is rendered by an async `<Slot>` RSC.
// These tests render the grid SYNCHRONOUSLY, so stub the provider to the no-module-bound default
// (renders nothing — DOM byte-identical to the baseline). The per-card slot's own rendering
// is covered by ProductCard.slot.spec.tsx + Slot.spec.tsx + the Playwright slot e2e.
vi.mock('@/components/cardActions', () => ({
  productCardActions: () => null,
}));
vi.mock('@/lib/catalog', () => ({
  fetchCategoryBySlug: (...a: unknown[]) => fetchCategoryBySlug(...a),
  fetchSearch: (...a: unknown[]) => fetchSearch(...a),
}));

// FilterSidebar (client) reads these URL-state hooks; the rest stay real (locale-aware Links).
vi.mock('@/i18n/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/i18n/navigation')>()),
  usePathname: () => '/category/apparel',
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(''),
}));

import {
  CategoryHeaderRowSection,
  CategoryFilterSidebarSection,
  CategoryResultsSection,
} from './CategorySections';

const EMPTY_FACETS = { categories: [], price: null };
const ctx = (searchParams: Record<string, string> = {}) => ({
  locale: 'en',
  params: { slug: 'apparel' },
  searchParams,
});

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
  fetchCategoryBySlug.mockResolvedValue(category());
  fetchSearch.mockResolvedValue({ products: [], total: 0, facets: EMPTY_FACETS });
});

describe('CategoryHeaderRowSection — verbatim justify-between row (h1 + SortControl)', () => {
  it('renders ONE row containing both the h1 and the sort form, with the verbatim classes', async () => {
    const data = await CategoryHeaderRowSection.loader!({}, ctx({ sort: 'price_asc' }));
    expect(fetchCategoryBySlug).toHaveBeenCalledWith('apparel');
    const node = CategoryHeaderRowSection.Component({ settings: {}, data, locale: 'en' });
    const { container } = renderWithIntl(<>{node}</>, 'en');
    const row = container.querySelector(
      'div.flex.flex-col.sm\\:flex-row.sm\\:items-center.sm\\:justify-between.gap-4.mb-6',
    );
    expect(row).not.toBeNull();
    // BOTH the h1 AND the sort form/select live inside that one row (the regression the split caused).
    const h1 = row!.querySelector('h1');
    expect(h1).toHaveClass('text-2xl', 'font-semibold');
    expect(h1).toHaveTextContent('Apparel');
    expect(row!.querySelector('form select[name="sort"]')).not.toBeNull();
    expect((row!.querySelector('select[name="sort"]') as HTMLSelectElement).value).toBe(
      'price_asc',
    );
  });

  it('preserves active price filters in the sort form (page NOT preserved) + locale-prefixed action', async () => {
    const data = await CategoryHeaderRowSection.loader!(
      {},
      ctx({ sort: 'price_asc', minPrice: '1000', maxPrice: '5000', currency: 'EUR', page: '3' }),
    );
    const node = CategoryHeaderRowSection.Component({ settings: {}, data, locale: 'en' });
    const { container } = renderWithIntl(<>{node}</>, 'en');
    const form = container.querySelector('form')!;
    expect(form.getAttribute('action')).toBe('/en/category/apparel');
    const hidden = Array.from(form.querySelectorAll('input[type="hidden"]')).map((i) => [
      i.getAttribute('name'),
      i.getAttribute('value'),
    ]);
    expect(hidden).toEqual(
      expect.arrayContaining([
        ['minPrice', '1000'],
        ['maxPrice', '5000'],
        ['currency', 'EUR'],
      ]),
    );
    // page is deliberately NOT carried (changing the sort resets pagination to 1).
    expect(hidden.find(([name]) => name === 'page')).toBeUndefined();
  });
});

describe('CategoryFilterSidebarSection', () => {
  it('renders the FilterSidebar with the category fixed by the route (price filter only)', async () => {
    fetchSearch.mockResolvedValue({
      products: [],
      total: 0,
      facets: {
        categories: [{ slug: 'other', name: 'Other', count: 2 }],
        price: { min: 0, max: 1000 },
      },
    });
    const data = await CategoryFilterSidebarSection.loader!({}, ctx());
    const node = CategoryFilterSidebarSection.Component({ settings: {}, data, locale: 'en' });
    renderWithIntl(<>{node}</>, 'en');
    // fixedCategory hides the category facet group → the "Other" category facet is NOT shown.
    expect(screen.queryByText('Other')).toBeNull();
    // Price filter IS shown (the facet has a price range).
    expect(screen.getByText('Price')).toBeInTheDocument();
  });
});

describe('CategoryResultsSection — verbatim results column', () => {
  it('renders the grid + the count <p> (mb-4) INSIDE the results column when non-empty', async () => {
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
    const data = await CategoryResultsSection.loader!({}, ctx());
    const node = await CategoryResultsSection.Component({ settings: {}, data, locale: 'en' });
    const { container } = renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByText('Cotton Tee')).toBeInTheDocument();
    expect(screen.getByText(/25[.,]00/)).toBeInTheDocument();
    // The result-count <p> with the verbatim `mb-4` lives in the results column (the ICU plural text is
    // formatted by real next-intl; the vitest shim does naive interpolation, so assert the element).
    expect(container.querySelector('p.text-sm.text-muted-foreground.mb-4')).not.toBeNull();
  });

  it('renders ONLY the empty <p> when there are no products (no count, no grid, no pagination)', async () => {
    const data = await CategoryResultsSection.loader!({}, ctx());
    const node = await CategoryResultsSection.Component({ settings: {}, data, locale: 'en' });
    const { container } = renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByText('No products in this category.')).toBeInTheDocument();
    // The count <p> (mb-4) is absent in the empty branch (parity).
    expect(container.querySelector('p.text-sm.text-muted-foreground.mb-4')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull();
  });
});

describe('CategoryResultsSection — pagination param preservation', () => {
  it('carries sort + price filters in the page hrefs with the right target page', async () => {
    // 80 total, pageSize 24 → page 2 has both Previous (page 1) and Next (page 3).
    fetchSearch.mockResolvedValue({ products: manyProducts(24), total: 80, facets: EMPTY_FACETS });
    const data = await CategoryResultsSection.loader!(
      {},
      ctx({ sort: 'price_asc', minPrice: '1000', currency: 'EUR', page: '2' }),
    );
    const node = await CategoryResultsSection.Component({ settings: {}, data, locale: 'en' });
    renderWithIntl(<>{node}</>, 'en');
    const prev = screen.getByRole('link', { name: 'Previous' });
    const next = screen.getByRole('link', { name: 'Next' });
    for (const link of [prev, next]) {
      expect(link).toHaveAttribute('href', expect.stringContaining('/en/category/apparel'));
      expect(link).toHaveAttribute('href', expect.stringContaining('sort=price_asc'));
      expect(link).toHaveAttribute('href', expect.stringContaining('minPrice=1000'));
      expect(link).toHaveAttribute('href', expect.stringContaining('currency=EUR'));
    }
    expect(prev).toHaveAttribute('href', expect.stringContaining('page=1'));
    expect(next).toHaveAttribute('href', expect.stringContaining('page=3'));
  });

  it('omits sort from params when relevance (default) — parity with the page', async () => {
    fetchSearch.mockResolvedValue({ products: manyProducts(24), total: 80, facets: EMPTY_FACETS });
    const data = await CategoryResultsSection.loader!({}, ctx({ page: '2' }));
    const node = await CategoryResultsSection.Component({ settings: {}, data, locale: 'en' });
    renderWithIntl(<>{node}</>, 'en');
    const next = screen.getByRole('link', { name: 'Next' });
    expect(next).toHaveAttribute('href', expect.not.stringContaining('sort='));
  });
});
