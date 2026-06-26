/**
 * ProductIndexer unit tests.
 *
 * Tests the document builder (published→doc fields correct, min-price,
 * availability) and the index-failure path (handler logs, does not throw).
 */
import { Logger } from '@nestjs/common';
import { ProductIndexer } from './product.indexer';
import { SearchService } from '../search.service';
import { DatabaseService } from '../../database/database.service';
import { StorageService } from '../../storage/storage.service';
import { TenantSettingsService } from '../../taxes/tenant-settings.service';

// ── Minimal stubs ─────────────────────────────────────────────────────────────

function makeSearchService(): jest.Mocked<Pick<SearchService, 'getClient' | 'productsIndex'>> {
  return {
    getClient: jest.fn(),
    productsIndex: jest.fn((tid) => `${tid}_products`),
  };
}

/** TenantSettingsService stub resolving a fixed default currency (or null). */
function makeSettings(defaultCurrency: string | null): TenantSettingsService {
  return {
    getOnboardingProfile: jest.fn().mockResolvedValue({ businessCountry: null, defaultCurrency }),
  } as unknown as TenantSettingsService;
}

function makeStorageService(): jest.Mocked<Pick<StorageService, 'getPublicUrl'>> {
  return {
    getPublicUrl: jest.fn((key: string) => `https://cdn.example.com/${key}`),
  };
}

// ── Test data ──────────────────────────────────────────────────────────────────

const NOW = new Date('2025-01-15T10:00:00Z');
const PRODUCT = {
  id: 'prod-1',
  tenantId: 'tenant-a',
  title: 'Test Tee',
  description: 'A nice tee',
  slug: 'test-tee',
  status: 'published',
  createdAt: NOW,
};

const VARIANTS = [
  { sku: 'sku-sm', priceAmount: 2000, currency: 'EUR', stockQuantity: 5, allowBackorder: false },
  { sku: 'sku-lg', priceAmount: 1500, currency: 'EUR', stockQuantity: 0, allowBackorder: false },
  { sku: 'sku-xl', priceAmount: 1800, currency: 'EUR', stockQuantity: 0, allowBackorder: true },
];

// ── _buildDoc unit tests ───────────────────────────────────────────────────────

describe('ProductIndexer._buildDoc', () => {
  let indexer: ProductIndexer;
  let dbService: jest.Mocked<DatabaseService>;

  beforeEach(() => {
    const searchSvc = makeSearchService() as unknown as SearchService;
    const storageSvc = makeStorageService() as unknown as StorageService;

    // We need the db.select to return different data per call.
    // Use a call counter to return the right fixture.
    let callCount = 0;
    const selectResponses: unknown[][] = [
      VARIANTS, // productVariants query
      [{ categoryId: 'cat-1' }], // productCategories query
      [{ slug: 'tshirts', name: 'T-Shirts' }], // categories query
      [{ tagId: 'tag-1' }], // productTags query
      [{ slug: 'summer', name: 'Summer' }], // tags query
      [], // productImages query (no images)
    ];

    const selectMock = jest.fn().mockImplementation(() => {
      const idx = callCount++;
      const returnValue = selectResponses[idx] ?? [];
      const chain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(returnValue),
        then: undefined as unknown,
      };
      chain.from.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      // Make the chain itself thenable (so await chain works).
      Object.defineProperty(chain, 'then', {
        get() {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            Promise.resolve(returnValue).then(resolve, reject);
        },
      });
      return chain;
    });

    dbService = {
      db: { select: selectMock },
    } as unknown as jest.Mocked<DatabaseService>;

    indexer = new ProductIndexer(searchSvc, dbService, storageSvc, makeSettings('EUR'));
  });

  it('maps published product to correct doc shape', async () => {
    const doc = await indexer._buildDoc('tenant-a', 'prod-1', PRODUCT);

    expect(doc.id).toBe('prod-1');
    expect(doc.tenantId).toBe('tenant-a');
    expect(doc.title).toBe('Test Tee');
    expect(doc.slug).toBe('test-tee');
    expect(doc.categorySlugs).toEqual(['tshirts']);
    expect(doc.categoryNames).toEqual(['T-Shirts']);
    expect(doc.tagSlugs).toEqual(['summer']);
    expect(doc.tagNames).toEqual(['Summer']);
    expect(doc.variantSkus).toEqual(['sku-sm', 'sku-lg', 'sku-xl']);
  });

  it('picks the MIN variant price (ignoring 0-price variants when others exist)', async () => {
    const doc = await indexer._buildDoc('tenant-a', 'prod-1', PRODUCT);
    // min of [2000, 1500, 1800] (all > 0) = 1500
    expect(doc.priceAmount).toBe(1500);
  });

  it('sets availability=true when any variant has stock > 0', async () => {
    const doc = await indexer._buildDoc('tenant-a', 'prod-1', PRODUCT);
    expect(doc.availability).toBe(true);
  });

  it('sets availability=true when any variant allows backorder (even stockQuantity=0)', async () => {
    // sku-xl has stockQuantity=0 but allowBackorder=true
    const doc = await indexer._buildDoc('tenant-a', 'prod-1', PRODUCT);
    expect(doc.availability).toBe(true);
  });

  it('createdAt is a unix epoch number', async () => {
    const doc = await indexer._buildDoc('tenant-a', 'prod-1', PRODUCT);
    expect(doc.createdAt).toBe(Math.floor(NOW.getTime() / 1000));
  });
});

describe('ProductIndexer._buildDoc availability=false', () => {
  it('returns availability=false when all variants have stock=0 and allowBackorder=false', async () => {
    const noStockVariants = [
      { sku: 'sku-a', priceAmount: 1000, currency: 'EUR', stockQuantity: 0, allowBackorder: false },
      { sku: 'sku-b', priceAmount: 2000, currency: 'EUR', stockQuantity: 0, allowBackorder: false },
    ];

    let callCount = 0;
    const selectResponses: unknown[][] = [
      noStockVariants,
      [], // no categories
      [], // no tags
      [], // no images
    ];

    const selectMock = jest.fn().mockImplementation(() => {
      const idx = callCount++;
      const returnValue = selectResponses[idx] ?? [];
      const chain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(returnValue),
      };
      chain.from.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      Object.defineProperty(chain, 'then', {
        get() {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            Promise.resolve(returnValue).then(resolve, reject);
        },
      });
      return chain;
    });

    const dbService = { db: { select: selectMock } } as unknown as DatabaseService;
    const searchSvc = makeSearchService() as unknown as SearchService;
    const storageSvc = makeStorageService() as unknown as StorageService;
    const indexer = new ProductIndexer(searchSvc, dbService, storageSvc, makeSettings('EUR'));

    const doc = await indexer._buildDoc('tenant-a', 'prod-1', PRODUCT);
    expect(doc.availability).toBe(false);
  });
});

// ── Multi-currency price/currency consistency ───────────────────────────────────
//
// priceAmount must be taken as Math.min WITHIN a single currency, not across all
// variants regardless of currency. Otherwise a product with EUR + JPY variants could
// index e.g. priceAmount=300 (a JPY integer) labelled "EUR", an apples-to-oranges
// integer that then drives cross-currency price filter/sort.
// Solution: pick a canonical currency (store default, else first-by-position variant)
// and take the min ONLY within that currency.
describe('ProductIndexer._buildDoc multi-currency consistency', () => {
  /** EUR + JPY variants. A naive Math.min over all prices would wrongly pick 300 (JPY). */
  const MIXED = [
    { sku: 'eur-a', priceAmount: 2000, currency: 'EUR', stockQuantity: 5, allowBackorder: false },
    { sku: 'eur-b', priceAmount: 2500, currency: 'EUR', stockQuantity: 5, allowBackorder: false },
    { sku: 'jpy-a', priceAmount: 300, currency: 'JPY', stockQuantity: 5, allowBackorder: false },
  ];

  function buildIndexer(defaultCurrency: string | null): ProductIndexer {
    let callCount = 0;
    const selectResponses: unknown[][] = [
      MIXED, // productVariants query (ordered by position in the source)
      [], // categories
      [], // tags
      [], // images
    ];
    const selectMock = jest.fn().mockImplementation(() => {
      const returnValue = selectResponses[callCount++] ?? [];
      const chain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(returnValue),
      };
      chain.from.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      Object.defineProperty(chain, 'then', {
        get() {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            Promise.resolve(returnValue).then(resolve, reject);
        },
      });
      return chain;
    });
    const dbService = { db: { select: selectMock } } as unknown as DatabaseService;
    const searchSvc = makeSearchService() as unknown as SearchService;
    const storageSvc = makeStorageService() as unknown as StorageService;
    return new ProductIndexer(searchSvc, dbService, storageSvc, makeSettings(defaultCurrency));
  }

  it('uses the store default currency and the MIN price WITHIN that currency (not across)', async () => {
    const indexer = buildIndexer('EUR');
    const doc = await indexer._buildDoc('tenant-a', 'prod-1', PRODUCT);
    expect(doc.currency).toBe('EUR');
    // min of the EUR variants only ([2000, 2500]) — NOT 300 (a JPY integer).
    expect(doc.priceAmount).toBe(2000);
  });

  it('falls back to the first-by-position variant currency when no store default is set', async () => {
    const indexer = buildIndexer(null);
    const doc = await indexer._buildDoc('tenant-a', 'prod-1', PRODUCT);
    // First variant (by position order) is EUR → canonical currency EUR, min within EUR.
    expect(doc.currency).toBe('EUR');
    expect(doc.priceAmount).toBe(2000);
  });
});

// ── Event handler: index-failure should log but not throw ─────────────────────

describe('ProductIndexer event handler failure isolation', () => {
  it('onProductCreated logs and does NOT throw when Meilisearch push fails', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    // DB returns a published product
    let callCount = 0;
    const selectMock = jest.fn().mockImplementation(() => {
      callCount++;
      const returnValue =
        callCount === 1
          ? [PRODUCT] // _loadProduct
          : callCount === 2
            ? VARIANTS // productVariants
            : callCount === 3
              ? [] // productCategories
              : callCount === 4
                ? [] // productTags
                : []; // productImages
      const chain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(returnValue),
      };
      chain.from.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      Object.defineProperty(chain, 'then', {
        get() {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            Promise.resolve(returnValue).then(resolve, reject);
        },
      });
      return chain;
    });

    const dbService = { db: { select: selectMock } } as unknown as DatabaseService;
    const storageSvc = makeStorageService() as unknown as StorageService;

    // Meilisearch addDocuments().waitTask() REJECTS (connection refused).
    const fakeIndex: Record<string, jest.Mock> = {
      addDocuments: jest.fn().mockReturnValue({
        waitTask: jest.fn().mockRejectedValue(new Error('Meilisearch connection refused')),
      }),
      updateSettings: jest.fn().mockReturnValue({
        waitTask: jest.fn().mockResolvedValue({ status: 'succeeded' }),
      }),
    };
    const fakeClient = {
      createIndex: jest.fn().mockReturnValue({
        waitTask: jest.fn().mockResolvedValue({ status: 'succeeded' }),
      }),
      index: jest.fn().mockReturnValue(fakeIndex),
    };

    const searchSvc = {
      getClient: jest.fn().mockResolvedValue(fakeClient),
      productsIndex: jest.fn((tid: string) => `${tid}_products`),
    } as unknown as SearchService;

    const indexer = new ProductIndexer(searchSvc, dbService, storageSvc, makeSettings('EUR'));

    // Should NOT throw
    await expect(
      indexer.onProductCreated({
        tenantId: 'tenant-a',
        productId: 'prod-1',
        title: 'T',
        status: 'published',
      } as never),
    ).resolves.toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[search] upsert failed'));

    logSpy.mockRestore();
  });

  // Note: waitTask() does NOT throw on a FAILED task — the indexer must detect the
  // non-succeeded status itself, log it, and still not throw out of the handler.
  it('onProductCreated logs and does NOT throw when addDocuments task status is "failed"', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

    let callCount = 0;
    const selectMock = jest.fn().mockImplementation(() => {
      callCount++;
      const returnValue =
        callCount === 1
          ? [PRODUCT] // _loadProduct
          : callCount === 2
            ? VARIANTS // productVariants
            : []; // categories / tags / images
      const chain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue(returnValue),
      };
      chain.from.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      chain.orderBy.mockReturnValue(chain);
      Object.defineProperty(chain, 'then', {
        get() {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            Promise.resolve(returnValue).then(resolve, reject);
        },
      });
      return chain;
    });

    const dbService = { db: { select: selectMock } } as unknown as DatabaseService;
    const storageSvc = makeStorageService() as unknown as StorageService;

    // addDocuments().waitTask() RESOLVES, but with status 'failed' (no throw).
    const fakeIndex: Record<string, jest.Mock> = {
      addDocuments: jest.fn().mockReturnValue({
        waitTask: jest.fn().mockResolvedValue({
          status: 'failed',
          error: { code: 'internal', message: 'disk full' },
        }),
      }),
      updateSettings: jest.fn().mockReturnValue({
        waitTask: jest.fn().mockResolvedValue({ status: 'succeeded' }),
      }),
    };
    const fakeClient = {
      createIndex: jest.fn().mockReturnValue({
        waitTask: jest.fn().mockResolvedValue({ status: 'succeeded' }),
      }),
      index: jest.fn().mockReturnValue(fakeIndex),
    };

    const searchSvc = {
      getClient: jest.fn().mockResolvedValue(fakeClient),
      productsIndex: jest.fn((tid: string) => `${tid}_products`),
    } as unknown as SearchService;

    const indexer = new ProductIndexer(searchSvc, dbService, storageSvc, makeSettings('EUR'));

    await expect(
      indexer.onProductCreated({
        tenantId: 'tenant-a',
        productId: 'prod-1',
        title: 'T',
        status: 'published',
      } as never),
    ).resolves.toBeUndefined();

    // Must have logged the upsert failure (the failed task surfaced as a throw).
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[search] upsert failed'));

    logSpy.mockRestore();
  });
});
