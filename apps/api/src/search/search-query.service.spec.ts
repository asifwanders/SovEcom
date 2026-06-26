/**
 * SearchQueryService unit tests.
 *
 * When a price filter (minPrice/maxPrice) or a price sort is used, the query MUST
 * be scoped to a SINGLE currency so an integer price comparison can never span
 * currencies (a ¥ integer vs a € integer). The currency is the explicit `currency`
 * param when given, else the tenant's default currency. A query with NO price
 * dimension is left currency-agnostic (single-currency stores behave exactly as before).
 */
import { SearchQueryService } from './search-query.service';
import { SearchService } from './search.service';
import { ProductIndexer } from './indexers/product.indexer';
import { TenantSettingsService } from '../taxes/tenant-settings.service';
import { SearchQuerySchema } from './dto/search-query.dto';

const TENANT = 'tenant-a';

/** Capture the SearchParams.filter passed to Meilisearch `.search()`. */
function makeHarness(defaultCurrency: string | null): {
  service: SearchQueryService;
  lastFilter: () => string[];
} {
  const captured: { filter?: unknown } = {};
  const fakeIndex = {
    search: jest.fn().mockImplementation((_q: string, params: { filter?: unknown }) => {
      captured.filter = params.filter;
      return Promise.resolve({
        hits: [],
        facetDistribution: {},
        facetStats: {},
        estimatedTotalHits: 0,
        processingTimeMs: 1,
      });
    }),
  };
  const fakeClient = { index: jest.fn().mockReturnValue(fakeIndex) };
  const searchSvc = {
    getClient: jest.fn().mockResolvedValue(fakeClient),
    productsIndex: jest.fn((tid: string) => `${tid}_products`),
  } as unknown as SearchService;
  const indexer = {
    ensureIndex: jest.fn().mockResolvedValue(undefined),
  } as unknown as ProductIndexer;
  const settings = {
    getOnboardingProfile: jest.fn().mockResolvedValue({ businessCountry: null, defaultCurrency }),
  } as unknown as TenantSettingsService;
  const service = new SearchQueryService(searchSvc, indexer, settings);
  return { service, lastFilter: () => (captured.filter as string[]) ?? [] };
}

describe('SearchQuerySchema currency param', () => {
  it('accepts and upper-cases a currency code', () => {
    const result = SearchQuerySchema.safeParse({ currency: 'eur' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.currency).toBe('EUR');
  });

  it('ignores a malformed currency rather than 500ing (public URL)', () => {
    const result = SearchQuerySchema.safeParse({ currency: 'not-a-code' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.currency).toBeUndefined();
  });
});

describe('SearchQueryService currency scoping', () => {
  it('scopes a price filter to the tenant default currency when none is given', async () => {
    const { service, lastFilter } = makeHarness('EUR');
    await service.query(TENANT, SearchQuerySchema.parse({ minPrice: '1000' }));
    expect(lastFilter()).toContain('currency = "EUR"');
    expect(lastFilter()).toContain('priceAmount >= 1000');
  });

  it('scopes a price SORT to the default currency too', async () => {
    const { service, lastFilter } = makeHarness('EUR');
    await service.query(TENANT, SearchQuerySchema.parse({ sort: 'price_asc' }));
    expect(lastFilter()).toContain('currency = "EUR"');
  });

  it('uses the explicit currency param over the default', async () => {
    const { service, lastFilter } = makeHarness('EUR');
    await service.query(TENANT, SearchQuerySchema.parse({ maxPrice: '5000', currency: 'usd' }));
    expect(lastFilter()).toContain('currency = "USD"');
    expect(lastFilter()).not.toContain('currency = "EUR"');
  });

  it('does NOT add a currency filter when there is no price dimension', async () => {
    const { service, lastFilter } = makeHarness('EUR');
    await service.query(TENANT, SearchQuerySchema.parse({ q: 'shirt' }));
    expect(lastFilter().some((f) => f.startsWith('currency ='))).toBe(false);
  });
});
