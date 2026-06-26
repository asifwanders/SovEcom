/**
 * Route-metadata builder tests.
 *
 * `buildRouteMetadata` is the shared, pure helper every `generateMetadata` calls: it produces the
 * canonical URL, the per-locale `hreflang` alternates, and OpenGraph + Twitter tags from a logical
 * path + locale + title/description (+ optional OG image). Keeping it pure means the route specs only
 * have to mock the catalog fetch, not Next's metadata internals.
 */
import { describe, it, expect } from 'vitest';
import { buildRouteMetadata } from './metadata';

const ORIGIN = 'https://shop.example';

/** Next's `openGraph`/`twitter` are deep unions; read them as plain records for assertion. */
const rec = (x: unknown): Record<string, unknown> => x as Record<string, unknown>;

describe('buildRouteMetadata', () => {
  it('sets the localized title/description', () => {
    const md = buildRouteMetadata({
      origin: ORIGIN,
      locale: 'en',
      path: '/products',
      title: 'Products',
      description: 'All products',
    });
    expect(md.title).toBe('Products');
    expect(md.description).toBe('All products');
  });

  it('sets a canonical to the current-locale URL and hreflang alternates for every locale', () => {
    const md = buildRouteMetadata({
      origin: ORIGIN,
      locale: 'fr',
      path: '/products',
      title: 'Produits',
      description: 'Tous les produits',
    });
    expect(md.alternates?.canonical).toBe('https://shop.example/fr/products');
    expect(md.alternates?.languages).toEqual({
      en: 'https://shop.example/en/products',
      fr: 'https://shop.example/fr/products',
    });
  });

  it('builds OpenGraph (url/type/title/description/locale) + a summary Twitter card', () => {
    const md = buildRouteMetadata({
      origin: ORIGIN,
      locale: 'en',
      path: '/product/tee',
      title: 'Cotton Tee',
      description: 'A soft tee',
      ogType: 'website',
    });
    expect(md.openGraph).toMatchObject({
      url: 'https://shop.example/en/product/tee',
      type: 'website',
      title: 'Cotton Tee',
      description: 'A soft tee',
      locale: 'en',
    });
    expect(md.twitter).toMatchObject({
      card: 'summary',
      title: 'Cotton Tee',
      description: 'A soft tee',
    });
  });

  it('adds the product image to OG + upgrades the Twitter card to summary_large_image', () => {
    const md = buildRouteMetadata({
      origin: ORIGIN,
      locale: 'en',
      path: '/product/tee',
      title: 'Cotton Tee',
      description: 'A soft tee',
      images: ['https://cdn.example/tee.jpg'],
    });
    expect(rec(md.openGraph).images).toEqual(['https://cdn.example/tee.jpg']);
    expect(rec(md.twitter).card).toBe('summary_large_image');
    expect(rec(md.twitter).images).toEqual(['https://cdn.example/tee.jpg']);
  });

  it('omits description when none is provided', () => {
    const md = buildRouteMetadata({
      origin: ORIGIN,
      locale: 'en',
      path: '/',
      title: 'Home',
    });
    expect(md.description).toBeUndefined();
    expect(md.alternates?.canonical).toBe('https://shop.example/en');
  });
});
