import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { SearchFacetsView } from '@/lib/catalog';

// Observe the URL writes without a real Next router. `usePathname` (next-intl, locale-stripped) +
// `useSearchParams` (next/navigation) feed current state; `replace` records the navigation target.
const replace = vi.fn();
const usePathname = vi.fn(() => '/search');
let currentParams = new URLSearchParams('');

vi.mock('@/i18n/navigation', () => ({
  usePathname: () => usePathname(),
  useRouter: () => ({ replace }),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => currentParams,
}));

import { FilterSidebar } from './FilterSidebar';

const facets: SearchFacetsView = {
  categories: [
    { slug: 'apparel', name: 'Apparel', count: 12 },
    { slug: 'shoes', name: 'Shoes', count: 3 },
  ],
  price: { min: 999, max: 25000 },
};

/** Decode the URLSearchParams of the most recent replace() call. */
function lastNavParams(): URLSearchParams {
  const arg = replace.mock.calls.at(-1)![0] as string;
  const qs = arg.includes('?') ? arg.slice(arg.indexOf('?') + 1) : '';
  return new URLSearchParams(qs);
}

beforeEach(() => {
  replace.mockReset();
  usePathname.mockReturnValue('/search');
  currentParams = new URLSearchParams('');
});

describe('FilterSidebar', () => {
  it('renders a labelled filter form with category facets + their counts', () => {
    renderWithIntl(<FilterSidebar facets={facets} currency="EUR" />, 'en');
    expect(screen.getByRole('form', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Category' })).toBeInTheDocument();
    expect(screen.getByText('Apparel')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Shoes')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('does not render a category fieldset when the category is fixed by the route (PLP)', () => {
    renderWithIntl(<FilterSidebar facets={facets} currency="EUR" fixedCategory="apparel" />, 'en');
    expect(screen.queryByRole('group', { name: 'Category' })).toBeNull();
    // Price filter is still present on a fixed-category PLP.
    expect(screen.getByRole('group', { name: 'Price' })).toBeInTheDocument();
  });

  it('selecting a category writes ?category= and resets page to 1, preserving q + sort', () => {
    currentParams = new URLSearchParams('q=tee&sort=price_asc&page=3');
    renderWithIntl(<FilterSidebar facets={facets} currency="EUR" />, 'en');
    fireEvent.click(screen.getByRole('checkbox', { name: /Apparel/ }));
    const p = lastNavParams();
    expect(p.get('category')).toBe('apparel');
    expect(p.get('q')).toBe('tee');
    expect(p.get('sort')).toBe('price_asc');
    expect(p.has('page')).toBe(false); // reset
  });

  it('toggling the active category OFF clears the ?category= param', () => {
    currentParams = new URLSearchParams('category=apparel');
    renderWithIntl(<FilterSidebar facets={facets} currency="EUR" />, 'en');
    const apparel = screen.getByRole('checkbox', { name: /Apparel/ });
    expect(apparel).toBeChecked();
    fireEvent.click(apparel);
    expect(lastNavParams().has('category')).toBe(false);
  });

  it('applying a price range writes minPrice/maxPrice in MINOR units (cents) + the currency', () => {
    renderWithIntl(<FilterSidebar facets={facets} currency="EUR" />, 'en');
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Max'), { target: { value: '50.50' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Filters' }));
    const p = lastNavParams();
    expect(p.get('minPrice')).toBe('1000'); // 10.00 EUR → 1000 cents
    expect(p.get('maxPrice')).toBe('5050'); // 50.50 EUR → 5050 cents
    expect(p.get('currency')).toBe('EUR');
  });

  it('applying a price range resets page to 1 and preserves q/category/sort', () => {
    currentParams = new URLSearchParams('q=tee&category=apparel&sort=newest&page=2');
    renderWithIntl(<FilterSidebar facets={facets} currency="EUR" />, 'en');
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '10' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Filters' }));
    const p = lastNavParams();
    expect(p.get('minPrice')).toBe('1000');
    expect(p.get('q')).toBe('tee');
    expect(p.get('category')).toBe('apparel');
    expect(p.get('sort')).toBe('newest');
    expect(p.has('page')).toBe(false);
  });

  it('a blank price input omits its param (no NaN/0 in the URL)', () => {
    renderWithIntl(<FilterSidebar facets={facets} currency="EUR" />, 'en');
    fireEvent.change(screen.getByLabelText('Min'), { target: { value: '10' } });
    // leave Max blank
    fireEvent.submit(screen.getByRole('form', { name: 'Filters' }));
    const p = lastNavParams();
    expect(p.get('minPrice')).toBe('1000');
    expect(p.has('maxPrice')).toBe(false);
  });

  it('clear-filters removes category/minPrice/maxPrice/currency but preserves q + sort', () => {
    currentParams = new URLSearchParams(
      'q=tee&sort=newest&category=apparel&minPrice=1000&maxPrice=5000&currency=EUR&page=2',
    );
    renderWithIntl(<FilterSidebar facets={facets} currency="EUR" />, 'en');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    const p = lastNavParams();
    expect(p.has('category')).toBe(false);
    expect(p.has('minPrice')).toBe(false);
    expect(p.has('maxPrice')).toBe(false);
    expect(p.has('currency')).toBe(false);
    expect(p.has('page')).toBe(false);
    expect(p.get('q')).toBe('tee');
    expect(p.get('sort')).toBe('newest');
  });

  it('pre-fills the price inputs from the active minPrice/maxPrice URL params (minor → major)', () => {
    currentParams = new URLSearchParams('minPrice=1999&maxPrice=5000');
    renderWithIntl(<FilterSidebar facets={facets} currency="EUR" />, 'en');
    expect(screen.getByLabelText('Min')).toHaveValue(19.99);
    expect(screen.getByLabelText('Max')).toHaveValue(50);
  });

  it('renders gracefully with empty facets (no category group, no price group)', () => {
    renderWithIntl(<FilterSidebar facets={{ categories: [], price: null }} currency="EUR" />, 'en');
    expect(screen.queryByRole('group', { name: 'Category' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Price' })).toBeNull();
  });

  it('localizes the filter labels in French', () => {
    renderWithIntl(<FilterSidebar facets={facets} currency="EUR" />, 'fr');
    expect(screen.getByRole('form', { name: 'Filtres' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Catégorie' })).toBeInTheDocument();
    expect(screen.getByLabelText('Min')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Effacer les filtres' })).toBeInTheDocument();
  });
});
