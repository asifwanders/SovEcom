import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-intl';
import { ProductCard } from './ProductCard';
import type { ProductCardView } from '@/lib/catalog';

function product(overrides: Partial<ProductCardView> = {}): ProductCardView {
  return {
    id: 'p1',
    slug: 'tee',
    title: 'Cotton Tee',
    thumbnailUrl: 'https://cdn/tee.jpg',
    priceAmount: 2500,
    currency: 'EUR',
    ...overrides,
  };
}

describe('ProductCard', () => {
  it('renders the title, price via formatPrice and a locale-aware PDP link', () => {
    renderWithIntl(<ProductCard product={product()} locale="en" />, 'en');
    expect(screen.getByText('Cotton Tee')).toBeInTheDocument();
    expect(screen.getByText(/25[.,]00/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/en/product/tee');
  });

  it('renders the thumbnail with explicit width/height + lazy/async', () => {
    renderWithIntl(<ProductCard product={product()} locale="en" />, 'en');
    const img = screen.getByRole('img', { name: 'Cotton Tee' });
    expect(img).toHaveAttribute('src', 'https://cdn/tee.jpg');
    expect(img).toHaveAttribute('width');
    expect(img).toHaveAttribute('height');
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
  });

  it('renders a localized "No image" placeholder when there is no thumbnail (S3)', () => {
    renderWithIntl(<ProductCard product={product({ thumbnailUrl: null })} locale="en" />, 'en');
    // gallery.noImage = "No image" in EN (was hardcoded string, now t('gallery.noImage')).
    expect(screen.getByText('No image')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders localized "Aucune image" placeholder in French (S3)', () => {
    renderWithIntl(<ProductCard product={product({ thumbnailUrl: null })} locale="fr" />, 'fr');
    // gallery.noImage = "Aucune image" in FR.
    expect(screen.getByText('Aucune image')).toBeInTheDocument();
  });

  it('omits the price when the product is unpriced', () => {
    renderWithIntl(
      <ProductCard product={product({ priceAmount: null, currency: null })} locale="en" />,
      'en',
    );
    expect(screen.getByText('Cotton Tee')).toBeInTheDocument();
    expect(screen.queryByText(/25[.,]00/)).toBeNull();
  });

  it('renders no actions seam by default (actions absent means nothing renders)', () => {
    // No `actions` node passed → the seam renders nothing; the card link is still the only link.
    const { container } = renderWithIntl(<ProductCard product={product()} locale="en" />, 'en');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(container.querySelector('a')).toHaveAttribute('href', '/en/product/tee');
  });

  it('renders a pre-rendered actions node beside the card link when provided', () => {
    renderWithIntl(
      <ProductCard
        product={product()}
        locale="en"
        actions={<button type="button">wishlist</button>}
      />,
      'en',
    );
    expect(screen.getByRole('button', { name: 'wishlist' })).toBeInTheDocument();
  });
});
