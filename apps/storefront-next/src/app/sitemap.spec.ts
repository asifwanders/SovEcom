/**
 * sitemap.ts test.
 *
 * Mocks the slug enumerators and asserts: the static routes + per-product + per-category URLs are
 * present, each entry is per-locale with hreflang `alternates.languages`, and a fetch failure
 * degrades to JUST the static routes (the build never crashes on a cold API).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchAllProductSlugs = vi.fn();
const fetchAllCategorySlugs = vi.fn();
vi.mock('@/lib/catalog', async (orig) => {
  const actual = await orig<typeof import('@/lib/catalog')>();
  return {
    ...actual,
    fetchAllProductSlugs: (...a: unknown[]) => fetchAllProductSlugs(...a),
    fetchAllCategorySlugs: (...a: unknown[]) => fetchAllCategorySlugs(...a),
  };
});

vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://shop.example');

import sitemap from './sitemap';

beforeEach(() => {
  fetchAllProductSlugs.mockReset();
  fetchAllCategorySlugs.mockReset();
});

function urls(entries: Awaited<ReturnType<typeof sitemap>>): string[] {
  return entries.map((e) => e.url);
}

describe('sitemap', () => {
  it('emits static + dynamic routes per locale with hreflang alternates', async () => {
    fetchAllProductSlugs.mockResolvedValue(['tee']);
    fetchAllCategorySlugs.mockResolvedValue(['apparel']);

    const entries = await sitemap();
    const all = urls(entries);

    // Static routes (both locales).
    expect(all).toContain('https://shop.example/en');
    expect(all).toContain('https://shop.example/fr');
    expect(all).toContain('https://shop.example/en/products');
    expect(all).toContain('https://shop.example/en/category');
    expect(all).toContain('https://shop.example/en/search');
    // Dynamic product + category routes (both locales).
    expect(all).toContain('https://shop.example/en/product/tee');
    expect(all).toContain('https://shop.example/fr/product/tee');
    expect(all).toContain('https://shop.example/en/category/apparel');
    expect(all).toContain('https://shop.example/fr/category/apparel');

    // Every entry carries per-locale hreflang alternates.
    const productEn = entries.find((e) => e.url === 'https://shop.example/en/product/tee');
    expect(productEn?.alternates?.languages).toEqual({
      en: 'https://shop.example/en/product/tee',
      fr: 'https://shop.example/fr/product/tee',
    });
  });

  it('degrades to ONLY the static routes when the enumerators throw (no crash)', async () => {
    fetchAllProductSlugs.mockRejectedValue(new Error('ECONNREFUSED'));
    fetchAllCategorySlugs.mockRejectedValue(new Error('ECONNREFUSED'));

    const all = urls(await sitemap());
    expect(all).toContain('https://shop.example/en');
    expect(all).toContain('https://shop.example/en/products');
    // No product/category PDPs when enumeration failed.
    expect(all.some((u) => u.includes('/product/'))).toBe(false);
    expect(all.some((u) => /\/category\/[^/]+$/.test(u))).toBe(false);
  });

  it('does not crash and still returns static routes when enumerators return empty', async () => {
    fetchAllProductSlugs.mockResolvedValue([]);
    fetchAllCategorySlugs.mockResolvedValue([]);
    const all = urls(await sitemap());
    expect(all).toContain('https://shop.example/fr/search');
  });
});
