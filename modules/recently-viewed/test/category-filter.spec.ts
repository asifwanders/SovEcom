/**
 * recently-viewed — excludeCategories seam unit tests (isExcludedByCategory + default resolver).
 */
import { describe, it, expect } from 'vitest';
import type { ModuleProductDto, StoreClient } from '@sovecom/module-sdk';
import {
  isExcludedByCategory,
  excludeNothingResolver,
  storeProductCategoryResolver,
  type ProductCategoryResolver,
} from '../src/category/category-filter';

const resolverFor = (map: Record<string, string[]>): ProductCategoryResolver => ({
  categoriesOf: (id) => Promise.resolve(new Set(map[id] ?? [])),
});

describe('recently-viewed category filter — isExcludedByCategory', () => {
  it('no exclusions configured → never excluded, never calls the resolver', async () => {
    let called = false;
    const resolver: ProductCategoryResolver = {
      categoriesOf: () => {
        called = true;
        return Promise.resolve(new Set(['x']));
      },
    };
    expect(await isExcludedByCategory('p1', [], resolver)).toBe(false);
    expect(called).toBe(false);
  });

  it('excluded when the product belongs to an excluded category', async () => {
    const resolver = resolverFor({ p1: ['cat-a', 'cat-b'] });
    expect(await isExcludedByCategory('p1', ['cat-b'], resolver)).toBe(true);
  });

  it('not excluded when the product has no overlap with the exclude set', async () => {
    const resolver = resolverFor({ p1: ['cat-a'] });
    expect(await isExcludedByCategory('p1', ['cat-z'], resolver)).toBe(false);
  });

  it('a product with no/unknown categories is never excluded', async () => {
    const resolver = resolverFor({});
    expect(await isExcludedByCategory('p-unknown', ['cat-a'], resolver)).toBe(false);
  });

  it('a resolver error fails OPEN (not excluded)', async () => {
    const resolver: ProductCategoryResolver = {
      categoriesOf: () => Promise.reject(new Error('boom')),
    };
    expect(await isExcludedByCategory('p1', ['cat-a'], resolver)).toBe(false);
  });

  it('excludeNothingResolver (retained fallback) excludes nothing', async () => {
    expect(await excludeNothingResolver.categoriesOf('p1')).toEqual(new Set());
    expect(await isExcludedByCategory('p1', ['cat-a'], excludeNothingResolver)).toBe(false);
  });
});

/** A minimal fake `sdk.store.products` returning a configurable DTO (incl. its primary category). */
function fakeProducts(
  byId: Record<string, ModuleProductDto | null>,
  failGet = false,
): StoreClient['products'] {
  return {
    list: () => Promise.resolve({ items: [] }),
    get: (id: string) => {
      if (failGet) return Promise.reject(new Error('catalog down'));
      return Promise.resolve(byId[id] ?? null);
    },
  };
}

describe('recently-viewed storeProductCategoryResolver (B1, reads ModuleProductDto.category)', () => {
  it('resolves the product PRIMARY category id from the catalog read', async () => {
    const products = fakeProducts({
      p1: {
        id: 'p1',
        slug: 's',
        title: 't',
        status: 'published',
        category: { id: 'cat-x', slug: 'cx', name: 'CX' },
      },
    });
    const resolver = storeProductCategoryResolver(products);
    expect(await resolver.categoriesOf('p1')).toEqual(new Set(['cat-x']));
  });

  it('a product with no category → empty set (never excluded)', async () => {
    const products = fakeProducts({
      p1: { id: 'p1', slug: 's', title: 't', status: 'published' },
    });
    const resolver = storeProductCategoryResolver(products);
    expect(await resolver.categoriesOf('p1')).toEqual(new Set());
  });

  it('an unknown product (get → null) → empty set', async () => {
    const resolver = storeProductCategoryResolver(fakeProducts({}));
    expect(await resolver.categoriesOf('ghost')).toEqual(new Set());
  });

  it('a failing catalog read degrades to empty set (fail-open)', async () => {
    const resolver = storeProductCategoryResolver(fakeProducts({}, true));
    expect(await resolver.categoriesOf('p1')).toEqual(new Set());
  });

  it('drives the exclude end-to-end: a product in an excluded category is excluded', async () => {
    const products = fakeProducts({
      hidden: {
        id: 'hidden',
        slug: 'h',
        title: 'H',
        status: 'published',
        category: { id: 'cat-hidden', slug: 'ch', name: 'Hidden' },
      },
      shown: {
        id: 'shown',
        slug: 'sh',
        title: 'S',
        status: 'published',
        category: { id: 'cat-ok', slug: 'co', name: 'OK' },
      },
    });
    const resolver = storeProductCategoryResolver(products);
    expect(await isExcludedByCategory('hidden', ['cat-hidden'], resolver)).toBe(true);
    expect(await isExcludedByCategory('shown', ['cat-hidden'], resolver)).toBe(false);
  });
});
