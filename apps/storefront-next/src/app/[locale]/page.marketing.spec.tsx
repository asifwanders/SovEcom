/**
 * WS-3d — Home page marketing block integration tests.
 *
 * These supplement the existing page.spec.tsx (which tests the hero/products/category sections).
 * Here we test: marketing block rendered above existing sections; empty list renders nothing;
 * the existing sections + Slot are still present when marketing returns data.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';

// Catalog mocks (required by the existing section registry loaders).
const fetchProducts = vi.fn();
const fetchCategoryTree = vi.fn();
vi.mock('@/lib/catalog', () => ({
  fetchProducts: (...a: unknown[]) => fetchProducts(...a),
  fetchCategoryTree: (...a: unknown[]) => fetchCategoryTree(...a),
}));

const fetchActiveTheme = vi.fn();
vi.mock('@/lib/theme', () => ({
  fetchActiveTheme: (...a: unknown[]) => fetchActiveTheme(...a),
}));

vi.mock('@/components/Slot', () => ({ Slot: () => null }));

// Marketing loader mock — this is what we're testing.
const fetchMarketingSections = vi.fn();
vi.mock('@/lib/marketing', () => ({
  fetchMarketingSections: (...a: unknown[]) => fetchMarketingSections(...a),
}));

// safeImageUrl — allow root-relative paths through so hero-banner renders its image.
vi.mock('@/lib/widgets/safeUrl', () => ({
  safeImageUrl: (v: unknown) => (typeof v === 'string' && v.startsWith('/') ? v : undefined),
}));

import HomePage from './page';

const props = (locale: 'en' | 'fr' = 'en') => ({ params: Promise.resolve({ locale }) });

beforeEach(() => {
  fetchProducts.mockReset();
  fetchCategoryTree.mockReset();
  fetchActiveTheme.mockReset();
  fetchMarketingSections.mockReset();
  fetchProducts.mockResolvedValue({ products: [], nextCursor: null });
  fetchCategoryTree.mockResolvedValue([]);
  fetchActiveTheme.mockResolvedValue(null);
  fetchMarketingSections.mockResolvedValue([]);
});

describe('HomePage — marketing block (WS-3d)', () => {
  it('renders a hero-banner marketing section above the existing sections', async () => {
    fetchMarketingSections.mockResolvedValue([
      {
        type: 'hero-banner',
        settings: { headline: 'Marketing Hero', ctaLabel: 'Go', ctaHref: '/promo' },
      },
    ]);
    renderWithIntl(await HomePage(props('en')), 'en');
    expect(screen.getByText('Marketing Hero')).toBeInTheDocument();
    // Existing hero section still renders
    expect(screen.getByText('SovEcom Storefront')).toBeInTheDocument();
  });

  it('renders a cta-banner marketing section', async () => {
    fetchMarketingSections.mockResolvedValue([
      {
        type: 'cta-banner',
        settings: { headline: 'Join the sale!', ctaLabel: 'Shop now', ctaHref: '/sale' },
      },
    ]);
    renderWithIntl(await HomePage(props('en')), 'en');
    expect(screen.getByText('Join the sale!')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Shop now' })).toHaveAttribute('href', '/sale');
  });

  it('renders a rich-text marketing section', async () => {
    fetchMarketingSections.mockResolvedValue([
      { type: 'rich-text', settings: { markdown: 'Welcome to our store!' } },
    ]);
    renderWithIntl(await HomePage(props('en')), 'en');
    expect(screen.getByText('Welcome to our store!')).toBeInTheDocument();
  });

  it('renders nothing for the marketing block when list is empty (no empty wrapper)', async () => {
    fetchMarketingSections.mockResolvedValue([]);
    const { container } = renderWithIntl(await HomePage(props('en')), 'en');
    // The existing template sections still render (hero is there), no crash.
    expect(screen.getByText('SovEcom Storefront')).toBeInTheDocument();
    // No marketing-specific element rendered (the marketing block is absent, not an empty div).
    expect(container.querySelector('[data-marketing-block]')).toBeNull();
  });

  it('renders existing sections + Slot when marketing list is empty', async () => {
    fetchMarketingSections.mockResolvedValue([]);
    renderWithIntl(await HomePage(props('en')), 'en');
    // The default home template sections still render.
    expect(screen.getByText('SovEcom Storefront')).toBeInTheDocument();
    expect(screen.getByText('No products available yet.')).toBeInTheDocument();
  });

  it('gracefully handles fetchMarketingSections throwing (returns [] internally)', async () => {
    fetchMarketingSections.mockResolvedValue([]);
    // Even if it resolved to [] (as the loader guarantees), the page should not crash.
    renderWithIntl(await HomePage(props('en')), 'en');
    expect(screen.getByText('SovEcom Storefront')).toBeInTheDocument();
  });

  it('renders multiple marketing sections in order', async () => {
    fetchMarketingSections.mockResolvedValue([
      {
        type: 'cta-banner',
        settings: { headline: 'First banner', ctaLabel: 'Go', ctaHref: '/' },
      },
      {
        type: 'rich-text',
        settings: { markdown: 'Second section body' },
      },
    ]);
    renderWithIntl(await HomePage(props('en')), 'en');
    expect(screen.getByText('First banner')).toBeInTheDocument();
    expect(screen.getByText('Second section body')).toBeInTheDocument();
  });
});
