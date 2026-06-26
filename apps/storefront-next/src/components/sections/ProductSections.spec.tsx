import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import type { ProductDetailView } from '@/lib/catalog';

/**
 * i — the granular PDP sections (the `product-main` composite decomposed into
 * `product-gallery` + `product-info` + `variant-selector`) plus `breadcrumbs`. Asserts each loader
 * fetches the cached product via `ctx.params.slug` and each component reproduces the pre-refactor PDP
 * markup VERBATIM. The gallery + selector are CLIENT sections (`client: true`). Parity is the gate.
 */

const fetchProductBySlug = vi.fn();
vi.mock('@/lib/catalog', () => ({
  fetchProductBySlug: (...a: unknown[]) => fetchProductBySlug(...a),
}));

// variant-selector hosts the <VariantSelector> island whose <AddToCartButton> calls useCart(); stub it
// so the island mounts without a real CartProvider (mirrors the PDP page spec).
const addItem = vi.fn<(variantId: string, quantity: number) => Promise<void>>();
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({ addItem }),
}));

import {
  ProductGallerySection,
  ProductInfoSection,
  VariantSelectorSection,
} from './ProductSections';
import { BreadcrumbsSection } from './BreadcrumbsSection';

function fullProduct(): ProductDetailView {
  return {
    id: 'p1',
    slug: 'tee',
    title: 'Cotton Tee',
    description: 'Soft organic cotton.',
    variants: [
      {
        id: 'v1',
        title: 'Small',
        options: { size: 'S' },
        priceAmount: 2500,
        currency: 'EUR',
        availability: true,
      },
      {
        id: 'v2',
        title: 'Large',
        options: { size: 'L' },
        priceAmount: 1999,
        currency: 'EUR',
        availability: false,
      },
    ],
    images: [{ thumbnailUrl: 'https://cdn/tee-1.jpg', altText: 'Front' }],
  };
}

beforeEach(() => {
  fetchProductBySlug.mockReset();
  addItem.mockReset();
  addItem.mockResolvedValue();
});

describe('ProductGallerySection (client island)', () => {
  it('is flagged as a client section', () => {
    expect(ProductGallerySection.client).toBe(true);
  });

  it('loader fetches the cached product via ctx.params.slug → serializable gallery props', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    const data = await ProductGallerySection.loader!({}, { locale: 'en', params: { slug: 'tee' } });
    expect(fetchProductBySlug).toHaveBeenCalledWith('tee');
    expect(data).toMatchObject({
      productTitle: 'Cotton Tee',
      images: [{ thumbnailUrl: 'https://cdn/tee-1.jpg', altText: 'Front' }],
    });
  });

  it('loader drops images with no thumbnail URL (verbatim gallery filter)', async () => {
    fetchProductBySlug.mockResolvedValue({
      ...fullProduct(),
      images: [
        { thumbnailUrl: 'https://cdn/a.jpg', altText: null },
        { thumbnailUrl: '', altText: null },
      ],
    });
    const data = (await ProductGallerySection.loader!(
      {},
      { locale: 'en', params: { slug: 'tee' } },
    )) as { images: unknown[] };
    expect(data.images).toHaveLength(1);
  });

  it('renders the ImageGallery from the loaded images', () => {
    const node = ProductGallerySection.Component({
      settings: {},
      data: { images: fullProduct().images, productTitle: 'Cotton Tee' },
      locale: 'en',
    });
    renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByRole('img').getAttribute('src')).toBe('https://cdn/tee-1.jpg');
  });

  it('loader returns null for an unknown slug; component renders nothing', async () => {
    fetchProductBySlug.mockResolvedValue(null);
    const data = await ProductGallerySection.loader!({}, { locale: 'en', params: { slug: 'x' } });
    expect(data).toBeNull();
    const { container } = render(
      <>{ProductGallerySection.Component({ settings: {}, data, locale: 'en' })}</>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // ii — the `layout` setting is passed through to ImageGallery (carousel default vs grid).
  const twoImages = [
    { thumbnailUrl: 'https://cdn/a.jpg', altText: 'A' },
    { thumbnailUrl: 'https://cdn/b.jpg', altText: 'B' },
  ];

  it('default settings → carousel gallery (tablist present)', () => {
    const node = ProductGallerySection.Component({
      settings: {},
      data: { images: twoImages, productTitle: 'Tee' },
      locale: 'en',
    });
    renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('settings.layout="grid" → all-images grid (no tablist; both images shown)', () => {
    const node = ProductGallerySection.Component({
      settings: { layout: 'grid' },
      data: { images: twoImages, productTitle: 'Tee' },
      locale: 'en',
    });
    renderWithIntl(<>{node}</>, 'en');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });

  it('an unknown layout value defensively falls back to the carousel', () => {
    const node = ProductGallerySection.Component({
      settings: { layout: 'spiral' },
      data: { images: twoImages, productTitle: 'Tee' },
      locale: 'en',
    });
    renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });
});

describe('ProductInfoSection (RSC)', () => {
  it('loader fetches the cached product via ctx.params.slug', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    const data = await ProductInfoSection.loader!({}, { locale: 'en', params: { slug: 'tee' } });
    expect(fetchProductBySlug).toHaveBeenCalledWith('tee');
    expect((data as { product: ProductDetailView }).product.title).toBe('Cotton Tee');
  });

  it('renders a BARE fragment (no space-y-6 wrapper): h1 (parity classes) + conditional prose', () => {
    const node = ProductInfoSection.Component({
      settings: {},
      data: { product: fullProduct() },
      locale: 'en',
    });
    const { container } = renderWithIntl(<>{node}</>, 'en');
    // PARITY: product-info is a BARE fragment — the `space-y-6` rhythm lives on the columns right region
    // (with the sibling variant-selector), so the section itself must NOT emit a `div.space-y-6` wrapper.
    expect(container.querySelector('div.space-y-6')).toBeNull();
    // h1 with the exact parity classes.
    const h1 = screen.getByRole('heading', { level: 1, name: 'Cotton Tee' });
    expect(h1).toHaveClass('text-3xl', 'font-bold', 'text-foreground');
    // Conditional description prose block.
    expect(container.querySelector('div.prose.prose-sm.max-w-none.text-foreground')).not.toBeNull();
    expect(screen.getByText('Soft organic cotton.')).toBeInTheDocument();
  });

  it('omits the description block when the product has no description', () => {
    const node = ProductInfoSection.Component({
      settings: {},
      data: { product: { ...fullProduct(), description: null } },
      locale: 'en',
    });
    const { container } = renderWithIntl(<>{node}</>, 'en');
    expect(container.querySelector('div.prose')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Cotton Tee' })).toBeInTheDocument();
  });

  it('renders nothing when the loader produced no product (defensive)', () => {
    const { container } = render(
      <>{ProductInfoSection.Component({ settings: {}, data: { product: null }, locale: 'en' })}</>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('VariantSelectorSection (client island)', () => {
  it('is flagged as a client section', () => {
    expect(VariantSelectorSection.client).toBe(true);
  });

  it('loader fetches the cached product via ctx.params.slug → serializable variant list', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    const data = await VariantSelectorSection.loader!(
      {},
      { locale: 'en', params: { slug: 'tee' } },
    );
    expect(fetchProductBySlug).toHaveBeenCalledWith('tee');
    expect((data as { variants: unknown[] }).variants).toHaveLength(2);
  });

  it('renders the VariantSelector with the size option axis', () => {
    const node = VariantSelectorSection.Component({
      settings: {},
      data: { variants: fullProduct().variants },
      locale: 'en',
    });
    renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByRole('combobox', { name: /size/i })).toBeInTheDocument();
  });

  it('renders nothing when the loader produced no product (defensive)', async () => {
    fetchProductBySlug.mockResolvedValue(null);
    const data = await VariantSelectorSection.loader!({}, { locale: 'en', params: { slug: 'x' } });
    expect(data).toBeNull();
    const { container } = render(
      <>{VariantSelectorSection.Component({ settings: {}, data, locale: 'en' })}</>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('BreadcrumbsSection', () => {
  it('loader fetches the cached product via ctx.params.slug', async () => {
    fetchProductBySlug.mockResolvedValue(fullProduct());
    const data = await BreadcrumbsSection.loader!({}, { locale: 'en', params: { slug: 'tee' } });
    expect(fetchProductBySlug).toHaveBeenCalledWith('tee');
    expect((data as { product: ProductDetailView }).product.slug).toBe('tee');
  });

  it('renders the Home → Products → product trail (last crumb = current page)', async () => {
    const node = await BreadcrumbsSection.Component({
      settings: {},
      data: { product: fullProduct() },
      locale: 'en',
    });
    renderWithIntl(<>{node}</>, 'en');
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/en');
    expect(screen.getByRole('link', { name: 'Products' })).toHaveAttribute('href', '/en/products');
    const current = screen.getByText('Cotton Tee');
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.tagName).toBe('SPAN');
  });

  it('renders nothing when the loader produced no product (defensive)', async () => {
    const node = await BreadcrumbsSection.Component({
      settings: {},
      data: { product: null },
      locale: 'en',
    });
    const { container } = render(<>{node}</>);
    expect(container).toBeEmptyDOMElement();
  });
});
