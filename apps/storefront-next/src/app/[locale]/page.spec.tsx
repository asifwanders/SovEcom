import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// The section loaders (`@/lib/sections/registry`) call these catalog reads; mock at the catalog seam
// so the section runtime exercises the real registry/template/renderer for `home`.
const fetchProducts = vi.fn();
const fetchCategoryTree = vi.fn();
vi.mock('@/lib/catalog', () => ({
  fetchProducts: (...a: unknown[]) => fetchProducts(...a),
  fetchCategoryTree: (...a: unknown[]) => fetchCategoryTree(...a),
}));

// Home now picks the active theme name to resolve the template-set; default it to null.
// Asserting `default`-set output matches the previous implementation.
const fetchActiveTheme = vi.fn();
vi.mock('@/lib/theme', () => ({
  fetchActiveTheme: (...a: unknown[]) => fetchActiveTheme(...a),
}));

// The home now renders an async `<Slot name="home-page-bottom">`. An async Client/RSC
// component can't be rendered by the sync test render; mock it to a benign no-op so specs
// stay focused on the section composition (the Slot runtime has its own dedicated specs).
vi.mock('@/components/Slot', () => ({ Slot: () => null }));

import HomePage from './page';

const props = (locale: 'en' | 'fr' = 'en') => ({ params: Promise.resolve({ locale }) });

beforeEach(() => {
  fetchProducts.mockReset();
  fetchCategoryTree.mockReset();
  fetchActiveTheme.mockReset();
  fetchProducts.mockResolvedValue({ products: [], nextCursor: null });
  fetchCategoryTree.mockResolvedValue([]);
  fetchActiveTheme.mockResolvedValue(null);
});

describe('HomePage', () => {
  it('renders hero heading + browse button (EN)', async () => {
    renderWithIntl(await HomePage(props('en')), 'en');
    expect(screen.getByText('SovEcom Storefront')).toBeInTheDocument();
    expect(screen.getByText('Browse products')).toBeInTheDocument();
  });

  it('renders French chrome when locale=fr', async () => {
    renderWithIntl(await HomePage(props('fr')), 'fr');
    expect(screen.getByText('Parcourir les produits')).toBeInTheDocument();
    expect(screen.getByText('Produits en vedette')).toBeInTheDocument();
  });

  it('renders featured products with prices via formatPrice', async () => {
    fetchProducts.mockResolvedValue({
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
      nextCursor: null,
    });
    renderWithIntl(await HomePage(props()));
    expect(screen.getByText('Cotton Tee')).toBeInTheDocument();
    // EUR 19.99 — exact glyph/spacing is locale-dependent, assert the digits + currency.
    expect(screen.getByText(/19[.,]99/)).toBeInTheDocument();
  });

  it('renders an empty state when there are no products', async () => {
    renderWithIntl(await HomePage(props()));
    expect(screen.getByText('No products available yet.')).toBeInTheDocument();
  });

  it('renders category links into the locale-prefixed PLP', async () => {
    fetchCategoryTree.mockResolvedValue([
      { id: 'c1', slug: 'apparel', name: 'Apparel', parentId: null, children: [] },
    ]);
    renderWithIntl(await HomePage(props('en')), 'en');
    const link = screen.getByRole('link', { name: 'Apparel' });
    expect(link).toHaveAttribute('href', '/en/category/apparel');
  });

  it('composes hero + featured grid + category pills together in order', async () => {
    fetchProducts.mockResolvedValue({
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
      nextCursor: null,
    });
    fetchCategoryTree.mockResolvedValue([
      { id: 'c1', slug: 'apparel', name: 'Apparel', parentId: null, children: [] },
    ]);
    const { container } = renderWithIntl(await HomePage(props('en')), 'en');
    // Wrapper container matches the expected layout.
    expect(container.querySelector('div.mx-auto.max-w-6xl.px-4.py-8.space-y-10')).not.toBeNull();
    // Hero, featured heading + a grid item, and the category pill are all present, in 3 sections.
    expect(screen.getByText('SovEcom Storefront')).toBeInTheDocument();
    expect(screen.getByText('Featured products')).toBeInTheDocument();
    expect(screen.getByText('Cotton Tee')).toBeInTheDocument();
    expect(screen.getByText('Shop by category')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Apparel' })).toBeInTheDocument();
    expect(container.querySelectorAll('section')).toHaveLength(3);

    // Verify section markup to catch class drift. These are the expected classes for each block.
    // Hero: rounded card with the primary-tinted background + the heading colour.
    const hero = screen.getByText('SovEcom Storefront').closest('section');
    expect(hero).toHaveClass('rounded-2xl', 'bg-primary/10', 'p-8', 'text-center');
    expect(screen.getByText('SovEcom Storefront').className).toContain('text-primary');
    // Featured: the section's heading is the exact h2 class.
    const featuredHeading = screen.getByText('Featured products');
    expect(featuredHeading.tagName).toBe('H2');
    expect(featuredHeading).toHaveClass('text-2xl', 'font-semibold', 'mb-6');
    // Category: the pill container is a wrapping flex row and each pill is a bordered rounded chip.
    const pill = screen.getByRole('link', { name: 'Apparel' });
    expect(pill).toHaveClass('rounded-full', 'border', 'border-border', 'bg-card', 'px-4', 'py-2');
    expect(pill.parentElement).toHaveClass('flex', 'flex-wrap', 'gap-3');
  });

  it('falls back to the bundled default set when no theme is active (empty grid + category)', async () => {
    fetchActiveTheme.mockResolvedValue(null);
    renderWithIntl(await HomePage(props('en')), 'en');
    // Default home template: hero + featured (empty state) sections render; category section is
    // omitted when there are no categories.
    expect(screen.getByText('SovEcom Storefront')).toBeInTheDocument();
    expect(screen.getByText('No products available yet.')).toBeInTheDocument();
    expect(screen.queryByText('Shop by category')).toBeNull();
  });

  describe('STOREFRONT_THEME env override', () => {
    // Clear any stubbed env after EACH test so a stubbed theme can't leak into a later test.
    afterEach(() => vi.unstubAllEnvs());

    it('env=boutique + null API theme → the BOUTIQUE home template renders (full-bleed hero)', async () => {
      vi.stubEnv('STOREFRONT_THEME', 'boutique');
      fetchActiveTheme.mockResolvedValue(null);
      renderWithIntl(await HomePage(props('en')), 'en');
      // The boutique home template sets the hero `fullBleed: true` → the full-bleed editorial band
      // (NOT the default rounded card). Proves the resolved name reached `renderSections` template pick.
      const hero = screen.getByText('SovEcom Storefront').closest('section')!;
      expect(hero.className).toContain('w-screen');
      expect(hero).not.toHaveClass('rounded-2xl');
    });

    it('env unset → the DEFAULT rounded-card hero (parity preserved)', async () => {
      // No env stub. The default theme home hero is the rounded card.
      fetchActiveTheme.mockResolvedValue(null);
      renderWithIntl(await HomePage(props('en')), 'en');
      const hero = screen.getByText('SovEcom Storefront').closest('section')!;
      expect(hero).toHaveClass('rounded-2xl');
      expect(hero.className).not.toContain('w-screen');
    });

    it('env override takes precedence over the API theme name', async () => {
      vi.stubEnv('STOREFRONT_THEME', 'boutique');
      // API returns the default theme, but the env override wins → boutique template.
      fetchActiveTheme.mockResolvedValue({ name: 'default', version: '1', settings: {} });
      renderWithIntl(await HomePage(props('en')), 'en');
      const hero = screen.getByText('SovEcom Storefront').closest('section')!;
      expect(hero.className).toContain('w-screen');
    });
  });
});
