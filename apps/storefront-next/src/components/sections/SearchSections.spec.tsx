import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

/**
 * the search result sections. Asserts parity markup + the load-bearing param
 * preservation: the SortControl + Pagination carry `q` (and the selectable category facet / price)
 * through navigation, while `page` resets on a sort change. The category facet is SHOWN here (no
 * fixedCategory), unlike the category PLP.
 */
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

vi.mock('@/i18n/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/i18n/navigation')>()),
  usePathname: () => '/search',
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(''),
}));

import {
  SearchResultsHeaderSection,
  SearchFilterSidebarSection,
  SearchProductGridSection,
  SearchPaginationSection,
} from './SearchSections';

const EMPTY_FACETS = { categories: [], price: null };
const ctx = (searchParams: Record<string, string> = {}) => ({ locale: 'en', searchParams });

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

describe('SearchResultsHeaderSection', () => {
  it('renders the count + a SortControl (with q preserved) when there are results', async () => {
    fetchSearch.mockResolvedValue({ products: manyProducts(2), total: 2, facets: EMPTY_FACETS });
    const data = await SearchResultsHeaderSection.loader!({}, ctx({ q: 'tee', sort: 'newest' }));
    const node = await SearchResultsHeaderSection.Component({ settings: {}, data, locale: 'en' });
    const { container } = renderWithIntl(<>{node}</>, 'en');
    // The result-count <p> is present (ICU plural text is formatted by real next-intl; the vitest shim
    // does naive interpolation, so assert the element + the SortControl, not the plural string).
    expect(container.querySelector('p.text-sm.text-muted-foreground')).not.toBeNull();
    expect(container.querySelector('select[name="sort"]')).not.toBeNull();
    const hidden = Array.from(container.querySelectorAll('input[type="hidden"]')).map((i) => [
      i.getAttribute('name'),
      i.getAttribute('value'),
    ]);
    expect(hidden).toEqual(expect.arrayContaining([['q', 'tee']]));
  });

  it('renders the count WITHOUT a SortControl when there are no results', async () => {
    const data = await SearchResultsHeaderSection.loader!({}, ctx({ q: 'zzz' }));
    const node = await SearchResultsHeaderSection.Component({ settings: {}, data, locale: 'en' });
    const { container } = renderWithIntl(<>{node}</>, 'en');
    // The count <p> still renders (parity), but with no results there is NO SortControl.
    expect(container.querySelector('p.text-sm.text-muted-foreground')).not.toBeNull();
    expect(container.querySelector('select[name="sort"]')).toBeNull();
  });
});

describe('SearchFilterSidebarSection', () => {
  it('SHOWS the selectable category facet (no fixedCategory)', async () => {
    fetchSearch.mockResolvedValue({
      products: [],
      total: 0,
      facets: { categories: [{ slug: 'shoes', name: 'Shoes', count: 4 }], price: null },
    });
    const data = await SearchFilterSidebarSection.loader!({}, ctx({ q: 'x' }));
    const node = SearchFilterSidebarSection.Component({ settings: {}, data, locale: 'en' });
    renderWithIntl(<>{node}</>, 'en');
    // Unlike the category PLP, the category facet group is rendered here.
    expect(screen.getByText('Shoes')).toBeInTheDocument();
  });
});

describe('SearchProductGridSection', () => {
  it('renders the no-results state with the query interpolated', async () => {
    const data = await SearchProductGridSection.loader!({}, ctx({ q: 'zzz' }));
    const node = await SearchProductGridSection.Component({ settings: {}, data, locale: 'en' });
    renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByText(/No results found/)).toBeInTheDocument();
  });

  it('renders the grid for a query with hits', async () => {
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
    const data = await SearchProductGridSection.loader!({}, ctx({ q: 'tee' }));
    const node = await SearchProductGridSection.Component({ settings: {}, data, locale: 'en' });
    renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByText('Cotton Tee')).toBeInTheDocument();
    expect(screen.getByText(/19[.,]99/)).toBeInTheDocument();
  });
});

describe('SearchPaginationSection — param preservation', () => {
  it('carries q + category + price in the page hrefs; targets the right page', async () => {
    // 80 total, pageSize 24 → page 2 has Previous (1) + Next (3).
    fetchSearch.mockResolvedValue({ products: manyProducts(24), total: 80, facets: EMPTY_FACETS });
    const data = await SearchPaginationSection.loader!(
      {},
      ctx({ q: 'tee', sort: 'price_asc', category: 'shoes', minPrice: '500', page: '2' }),
    );
    const node = SearchPaginationSection.Component({ settings: {}, data, locale: 'en' });
    renderWithIntl(<>{node}</>, 'en');
    const prev = screen.getByRole('link', { name: 'Previous' });
    const next = screen.getByRole('link', { name: 'Next' });
    for (const link of [prev, next]) {
      expect(link).toHaveAttribute('href', expect.stringContaining('q=tee'));
      expect(link).toHaveAttribute('href', expect.stringContaining('sort=price_asc'));
      expect(link).toHaveAttribute('href', expect.stringContaining('category=shoes'));
      expect(link).toHaveAttribute('href', expect.stringContaining('minPrice=500'));
    }
    expect(prev).toHaveAttribute('href', expect.stringContaining('page=1'));
    expect(next).toHaveAttribute('href', expect.stringContaining('page=3'));
  });

  it('renders nothing when there are no products (parity with the page)', async () => {
    const data = await SearchPaginationSection.loader!({}, ctx({ q: 'zzz' }));
    const node = SearchPaginationSection.Component({ settings: {}, data, locale: 'en' });
    const { container } = renderWithIntl(<>{node}</>, 'en');
    expect(container).toBeEmptyDOMElement();
  });
});
