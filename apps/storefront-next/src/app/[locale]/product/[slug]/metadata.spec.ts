/**
 * PDP `generateMetadata` test. Mocks the catalog fetch + the site
 * origin and asserts the resolved title/description, canonical + hreflang alternates, and the OG
 * product image.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchProductBySlug = vi.fn();
vi.mock('@/lib/catalog', async (orig) => {
  const actual = await orig<typeof import('@/lib/catalog')>();
  return { ...actual, fetchProductBySlug: (...a: unknown[]) => fetchProductBySlug(...a) };
});

vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://shop.example');

import { generateMetadata } from './page';

beforeEach(() => fetchProductBySlug.mockReset());

const product = {
  id: 'p1',
  slug: 'tee',
  title: 'Cotton Tee',
  description: 'A soft cotton tee.',
  variants: [
    { id: 'v1', title: 'S', options: {}, priceAmount: 1999, currency: 'EUR', availability: true },
  ],
  images: [{ thumbnailUrl: 'https://cdn.example/tee.jpg', altText: 'front' }],
};

describe('PDP generateMetadata', () => {
  it('uses the product title/description + canonical + hreflang + OG image', async () => {
    fetchProductBySlug.mockResolvedValue(product);
    const md = await generateMetadata({
      params: Promise.resolve({ locale: 'en', slug: 'tee' }),
    });
    expect(md.title).toBe('Cotton Tee');
    expect(md.description).toBe('A soft cotton tee.');
    expect(md.alternates?.canonical).toBe('https://shop.example/en/product/tee');
    expect(md.alternates?.languages).toMatchObject({
      en: 'https://shop.example/en/product/tee',
      fr: 'https://shop.example/fr/product/tee',
    });
    expect(md.openGraph?.images).toEqual(['https://cdn.example/tee.jpg']);
  });

  it('returns empty metadata for an unknown product (404)', async () => {
    fetchProductBySlug.mockResolvedValue(null);
    const md = await generateMetadata({
      params: Promise.resolve({ locale: 'en', slug: 'nope' }),
    });
    expect(md).toEqual({});
  });
});
