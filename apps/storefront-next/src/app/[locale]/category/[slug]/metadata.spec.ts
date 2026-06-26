/**
 * Category PLP `generateMetadata` test. Mocks the category fetch +
 * site origin and asserts title/description, canonical, and hreflang alternates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchCategoryBySlug = vi.fn();
vi.mock('@/lib/catalog', async (orig) => {
  const actual = await orig<typeof import('@/lib/catalog')>();
  return { ...actual, fetchCategoryBySlug: (...a: unknown[]) => fetchCategoryBySlug(...a) };
});

vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://shop.example');

import { generateMetadata } from './page';

beforeEach(() => fetchCategoryBySlug.mockReset());

describe('Category generateMetadata', () => {
  it('uses the category name as the title + canonical + hreflang', async () => {
    fetchCategoryBySlug.mockResolvedValue({
      id: 'c1',
      slug: 'apparel',
      name: 'Apparel',
      parentId: null,
      children: [],
    });
    const md = await generateMetadata({
      params: Promise.resolve({ locale: 'en', slug: 'apparel' }),
    });
    expect(md.title).toBe('Apparel');
    expect(md.alternates?.canonical).toBe('https://shop.example/en/category/apparel');
    expect(md.alternates?.languages).toMatchObject({
      en: 'https://shop.example/en/category/apparel',
      fr: 'https://shop.example/fr/category/apparel',
    });
  });

  it('returns empty metadata for an unknown category (404)', async () => {
    fetchCategoryBySlug.mockResolvedValue(null);
    const md = await generateMetadata({
      params: Promise.resolve({ locale: 'en', slug: 'nope' }),
    });
    expect(md).toEqual({});
  });
});
