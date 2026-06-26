import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// catalog.ts constructs a client via createStoreClient. Mock that module so each test
// injects a fake `request` and asserts the params passed + the mapping of the raw DTO to view-types.
const request = vi.fn();
vi.mock('./store-client', () => ({
  createStoreClient: () => ({ request }),
}));

import {
  fetchProducts,
  fetchCategoryTree,
  fetchCategoryBySlug,
  fetchSearch,
  fetchProductBySlug,
} from './catalog';
import { SovEcomApiError } from '@sovecom/client-js';

beforeEach(() => {
  request.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchProducts', () => {
  it('maps store products to cards using the lowest variant price + first image', async () => {
    request.mockResolvedValue({
      data: [
        {
          id: 'p1',
          slug: 'tee',
          title: 'Tee',
          variants: [
            { priceAmount: 2500, currency: 'EUR' },
            { priceAmount: 1999, currency: 'EUR' },
          ],
          images: [{ thumbnailUrl: 'https://cdn/tee.jpg' }],
        },
      ],
      nextCursor: 'CURSOR2',
    });

    const result = await fetchProducts({ pageSize: 8 });

    expect(result.products).toEqual([
      {
        id: 'p1',
        slug: 'tee',
        title: 'Tee',
        thumbnailUrl: 'https://cdn/tee.jpg',
        priceAmount: 1999,
        currency: 'EUR',
      },
    ]);
    expect(result.nextCursor).toBe('CURSOR2');
    expect(request).toHaveBeenCalledWith('get', '/store/v1/products', { query: { pageSize: 8 } });
  });

  it('forwards the cursor param when paginating', async () => {
    request.mockResolvedValue({ data: [], nextCursor: null });
    await fetchProducts({ pageSize: 24, cursor: 'abc' });
    expect(request).toHaveBeenCalledWith('get', '/store/v1/products', {
      query: { pageSize: 24, cursor: 'abc' },
    });
  });

  it('handles products with no variants/images (null price + thumbnail)', async () => {
    request.mockResolvedValue({
      data: [{ id: 'p2', slug: 'x', title: 'X' }],
      nextCursor: null,
    });
    const result = await fetchProducts({});
    expect(result.products[0]).toMatchObject({
      priceAmount: null,
      currency: null,
      thumbnailUrl: null,
    });
  });

  it('returns an empty page when the API is unreachable (graceful)', async () => {
    request.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await fetchProducts({ pageSize: 8 });
    expect(result).toEqual({ products: [], nextCursor: null });
  });
});

describe('fetchCategoryTree', () => {
  it('maps the nested tree', async () => {
    request.mockResolvedValue({
      data: [
        {
          id: 'c1',
          slug: 'apparel',
          name: 'Apparel',
          parentId: null,
          children: [{ id: 'c2', slug: 'tees', name: 'Tees', parentId: 'c1' }],
        },
      ],
    });
    const tree = await fetchCategoryTree();
    expect(tree[0]!.name).toBe('Apparel');
    expect(tree[0]!.children[0]!.slug).toBe('tees');
    expect(request).toHaveBeenCalledWith('get', '/store/v1/categories/tree');
  });

  it('returns [] on transport error', async () => {
    request.mockRejectedValue(new Error('boom'));
    expect(await fetchCategoryTree()).toEqual([]);
  });
});

describe('fetchCategoryBySlug', () => {
  it('maps a found category', async () => {
    request.mockResolvedValue({ id: 'c1', slug: 'apparel', name: 'Apparel', parentId: null });
    const cat = await fetchCategoryBySlug('apparel');
    expect(cat).toMatchObject({ slug: 'apparel', name: 'Apparel', children: [] });
    expect(request).toHaveBeenCalledWith('get', '/store/v1/categories/{slug}', {
      path: { slug: 'apparel' },
    });
  });

  it('returns null on a 404 (unknown slug)', async () => {
    request.mockRejectedValue(
      new SovEcomApiError(404, 'Not Found', { message: 'Category not found' }),
    );
    expect(await fetchCategoryBySlug('nope')).toBeNull();
  });

  it('returns null on transport error (graceful)', async () => {
    request.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchCategoryBySlug('apparel')).toBeNull();
  });
});

describe('fetchSearch', () => {
  it('maps hits to cards and forwards q + filters', async () => {
    request.mockResolvedValue({
      hits: [
        {
          id: 'p1',
          slug: 'tee',
          title: 'Tee',
          thumbnailUrl: 'https://cdn/tee.jpg',
          priceAmount: 1999,
          currency: 'EUR',
        },
      ],
      facets: { categories: [], price: null },
      total: 1,
    });
    const result = await fetchSearch({ q: 'tee', category: 'apparel', page: 1, pageSize: 24 });
    expect(result.products).toEqual([
      {
        id: 'p1',
        slug: 'tee',
        title: 'Tee',
        thumbnailUrl: 'https://cdn/tee.jpg',
        priceAmount: 1999,
        currency: 'EUR',
      },
    ]);
    expect(result.total).toBe(1);
    expect(request).toHaveBeenCalledWith('get', '/store/v1/search', {
      query: { q: 'tee', category: 'apparel', page: 1, pageSize: 24 },
    });
  });

  it('maps category + price facets the API returns (minor units carried through)', async () => {
    request.mockResolvedValue({
      hits: [],
      facets: {
        categories: [
          { slug: 'apparel', name: 'Apparel', count: 12 },
          { slug: 'shoes', name: 'Shoes', count: 3 },
        ],
        price: { min: 999, max: 25000 },
      },
      total: 15,
    });
    const result = await fetchSearch({ q: 'tee' });
    expect(result.facets.categories).toEqual([
      { slug: 'apparel', name: 'Apparel', count: 12 },
      { slug: 'shoes', name: 'Shoes', count: 3 },
    ]);
    // Price stays in integer minor units (cents) — converted to major ONLY at display time.
    expect(result.facets.price).toEqual({ min: 999, max: 25000 });
  });

  it('defaults to empty facets when the API omits them (resilient — no crash)', async () => {
    request.mockResolvedValue({ hits: [], total: 0 });
    const result = await fetchSearch({ q: 'tee' });
    expect(result.facets).toEqual({ categories: [], price: null });
  });

  it('tolerates a partial facets shape (missing count → 0, missing price → null)', async () => {
    request.mockResolvedValue({
      hits: [],
      facets: { categories: [{ slug: 'apparel', name: 'Apparel' }] },
      total: 0,
    });
    const result = await fetchSearch({ q: 'tee' });
    expect(result.facets.categories).toEqual([{ slug: 'apparel', name: 'Apparel', count: 0 }]);
    expect(result.facets.price).toBeNull();
  });

  it('drops a malformed (non-finite) price facet to null', async () => {
    request.mockResolvedValue({
      hits: [],
      facets: { categories: [], price: { min: Number.NaN, max: 100 } },
      total: 0,
    });
    const result = await fetchSearch({ q: 'tee' });
    expect(result.facets.price).toBeNull();
  });

  it('forwards minPrice/maxPrice/currency/tag filters in integer minor units', async () => {
    request.mockResolvedValue({ hits: [], facets: { categories: [], price: null }, total: 0 });
    await fetchSearch({
      category: 'apparel',
      tag: 'sale',
      minPrice: 1000,
      maxPrice: 5000,
      currency: 'EUR',
      pageSize: 24,
    });
    expect(request).toHaveBeenCalledWith('get', '/store/v1/search', {
      query: {
        category: 'apparel',
        tag: 'sale',
        minPrice: 1000,
        maxPrice: 5000,
        currency: 'EUR',
        pageSize: 24,
      },
    });
  });

  it('omits an empty q (browse-all) from the query', async () => {
    request.mockResolvedValue({ hits: [], facets: { categories: [], price: null }, total: 0 });
    await fetchSearch({ q: '', pageSize: 24 });
    expect(request).toHaveBeenCalledWith('get', '/store/v1/search', { query: { pageSize: 24 } });
  });

  it('returns an empty result with empty facets on transport error', async () => {
    request.mockRejectedValue(new Error('boom'));
    expect(await fetchSearch({ q: 'tee' })).toEqual({
      products: [],
      facets: { categories: [], price: null },
      total: 0,
    });
  });
});

describe('fetchProductBySlug', () => {
  it('maps the store product DTO to the detail view (variants + images)', async () => {
    request.mockResolvedValue({
      id: 'p1',
      slug: 'tee',
      title: 'Cotton Tee',
      description: 'Soft organic cotton.',
      status: 'published',
      seoTitle: null,
      seoDescription: null,
      variants: [
        {
          id: 'v1',
          title: 'Small',
          options: { size: 'S' },
          priceAmount: 2500,
          currency: 'EUR',
          compareAtAmount: null,
          availability: true,
          position: 0,
        },
        {
          id: 'v2',
          title: 'Large',
          options: { size: 'L' },
          priceAmount: 1999,
          currency: 'EUR',
          compareAtAmount: null,
          availability: false,
          position: 1,
        },
      ],
      images: [
        { thumbnailUrl: 'https://cdn/tee-1.jpg', altText: 'Front', position: 0 },
        { thumbnailUrl: 'https://cdn/tee-2.jpg', altText: null, position: 1 },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const product = await fetchProductBySlug('tee');

    expect(product).toEqual({
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
      images: [
        { thumbnailUrl: 'https://cdn/tee-1.jpg', altText: 'Front' },
        { thumbnailUrl: 'https://cdn/tee-2.jpg', altText: null },
      ],
    });
    expect(request).toHaveBeenCalledWith('get', '/store/v1/products/{slug}', {
      path: { slug: 'tee' },
    });
  });

  it('handles a product with no variants/images/description gracefully', async () => {
    request.mockResolvedValue({ id: 'p2', slug: 'bare', title: 'Bare' });
    const product = await fetchProductBySlug('bare');
    expect(product).toEqual({
      id: 'p2',
      slug: 'bare',
      title: 'Bare',
      description: null,
      variants: [],
      images: [],
    });
  });

  it('returns null when the slug does not exist (API 404)', async () => {
    request.mockRejectedValue(
      new SovEcomApiError(404, 'Not Found', { message: 'Product not found' }),
    );
    expect(await fetchProductBySlug('nope')).toBeNull();
  });

  it('returns null on transport error (cold API → notFound, never 500)', async () => {
    request.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchProductBySlug('tee')).toBeNull();
  });
});
