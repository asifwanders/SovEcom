import { describe, it, expect } from 'vitest';
import {
  parseQuery,
  categorySearchArgs,
  searchSearchArgs,
  productListArgs,
  PAGE_SIZE,
  PRODUCTS_PAGE_SIZE,
} from './search-args';

/**
 * the shared search-args builders. The load-bearing property is that every
 * results-consuming section loader derives its `fetchSearch`/`fetchProducts` args from ONE
 * deterministic builder, so the args are IDENTICAL across grid/pagination/header — which, combined
 * with the `cache()`-wrapped builders + fetchers (keyed on arg identity in the RSC request scope),
 * collapses the round-trips to one per render pass. These specs assert the builders are deterministic
 * (same input → equal output) + that the arg shapes mirror the pre-refactor pages. (Reference IDENTITY
 * via `cache()` only holds inside a React request scope, which the vitest harness doesn't provide, so
 * it's verified by value-equality here + exercised end-to-end by the page/section specs.)
 */
describe('parseQuery', () => {
  it('parses + normalises the raw searchParams (verbatim page semantics)', () => {
    const q = parseQuery({
      q: '  tee  ',
      sort: 'price_asc',
      page: '3',
      category: 'shoes',
      minPrice: '1000',
      maxPrice: '5000',
      currency: 'EUR',
    });
    expect(q).toEqual({
      q: 'tee',
      sort: 'price_asc',
      page: 3,
      category: 'shoes',
      minPrice: 1000,
      maxPrice: 5000,
      currency: 'EUR',
    });
  });

  it('defaults garbage to the page fallbacks (relevance / page 1 / omitted prices)', () => {
    const q = parseQuery({ sort: 'nope', page: 'abc', minPrice: '-5' });
    expect(q.sort).toBe('relevance');
    expect(q.page).toBe(1);
    expect(q.minPrice).toBeUndefined();
  });
});

describe('categorySearchArgs', () => {
  it('fixes the category to the route slug + carries sort/page/price (never q)', () => {
    const args = categorySearchArgs(
      'apparel',
      parseQuery({ sort: 'newest', page: '2', currency: 'EUR' }),
    );
    expect(args).toMatchObject({
      category: 'apparel',
      sort: 'newest',
      page: 2,
      pageSize: PAGE_SIZE,
    });
    expect(args).not.toHaveProperty('q');
  });

  it('is deterministic: same (slug, query) → equal args (the cache key matches across loaders)', () => {
    const a = categorySearchArgs('apparel', parseQuery({ sort: 'newest', page: '2' }));
    const b = categorySearchArgs('apparel', parseQuery({ sort: 'newest', page: '2' }));
    expect(a).toEqual(b);
  });

  it('differs for different inputs (distinct cache keys → distinct fetches)', () => {
    const a = categorySearchArgs('apparel', parseQuery({ page: '1' }));
    const b = categorySearchArgs('apparel', parseQuery({ page: '2' }));
    expect(a).not.toEqual(b);
  });
});

describe('searchSearchArgs', () => {
  it('sends q + the selectable category facet', () => {
    const args = searchSearchArgs(parseQuery({ q: 'tee', category: 'shoes', sort: 'relevance' }));
    expect(args).toMatchObject({ q: 'tee', category: 'shoes', pageSize: PAGE_SIZE });
  });

  it('is deterministic: same query → equal args', () => {
    const a = searchSearchArgs(parseQuery({ q: 'tee', page: '2' }));
    const b = searchSearchArgs(parseQuery({ q: 'tee', page: '2' }));
    expect(a).toEqual(b);
  });
});

describe('productListArgs', () => {
  it('builds deterministic page-size (+cursor) args for the same cursor', () => {
    const a = productListArgs({ cursor: 'X==' });
    const b = productListArgs({ cursor: 'X==' });
    expect(a).toEqual(b);
    expect(a).toEqual({ pageSize: PRODUCTS_PAGE_SIZE, cursor: 'X==' });
  });

  it('omits the cursor when absent', () => {
    expect(productListArgs({})).toEqual({ pageSize: PRODUCTS_PAGE_SIZE });
  });
});
