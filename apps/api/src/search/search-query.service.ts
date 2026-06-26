/**
 * SearchQueryService.
 *
 * Translates the incoming SearchQueryDto into a Meilisearch search call against
 * the tenant-scoped `${tenantId}_products` index. Returns raw Meilisearch results
 * plus assembled facets.
 *
 * Tenant isolation: the primary guard is index-per-tenant (structural — a search
 * only ever targets `${tenantId}_products`). As defense-in-depth (F2, Fable) this
 * ALSO appends an unconditional `tenantId = "<tenantId>"` filter, so even if the
 * index uid were ever wrong, a cross-tenant read is doubly impossible.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Filter, SearchParams } from 'meilisearch';
import { SearchService } from './search.service';
import { ProductIndexer } from './indexers/product.indexer';
import { TenantSettingsService } from '../taxes/tenant-settings.service';
import type { SearchQueryDto } from './dto/search-query.dto';
import type {
  SearchResultDto,
  SearchProductCard,
  CategoryFacet,
  PriceFacetStats,
} from './dto/search-result.dto';

type RawHit = Record<string, unknown>;

@Injectable()
export class SearchQueryService {
  private readonly logger = new Logger(SearchQueryService.name);

  constructor(
    private readonly searchSvc: SearchService,
    private readonly indexer: ProductIndexer,
    private readonly settings: TenantSettingsService,
  ) {}

  async query(tenantId: string, dto: SearchQueryDto): Promise<SearchResultDto> {
    // Ensure the index + settings exist before first query.
    try {
      await this.indexer.ensureIndex(tenantId);
    } catch {
      // Log + fall through; Meilisearch will return an error handled below.
    }

    const client = await this.searchSvc.getClient();
    const indexName = this.searchSvc.productsIndex(tenantId);

    // ── Build filter array ─────────────────────────────────────────────────────
    // F2 (Fable): unconditional tenant filter as defense-in-depth on top of the
    // index-per-tenant structural isolation. `tenantId` is a filterable attribute.
    const filterParts: string[] = [`tenantId = "${escapeFilterValue(tenantId)}"`];

    if (dto.category) {
      filterParts.push(`categorySlugs = "${escapeFilterValue(dto.category)}"`);
    }
    if (dto.tag) {
      filterParts.push(`tagSlugs = "${escapeFilterValue(dto.tag)}"`);
    }
    if (dto.minPrice !== undefined && dto.minPrice > 0) {
      filterParts.push(`priceAmount >= ${dto.minPrice}`);
    }
    if (dto.maxPrice !== undefined && dto.maxPrice > 0) {
      filterParts.push(`priceAmount <= ${dto.maxPrice}`);
    }

    // ── Sort ───────────────────────────────────────────────────────────────────
    let sort: string[] | undefined;
    switch (dto.sort) {
      case 'price_asc':
        sort = ['priceAmount:asc'];
        break;
      case 'price_desc':
        sort = ['priceAmount:desc'];
        break;
      case 'newest':
        sort = ['createdAt:desc'];
        break;
      case 'relevance':
      default:
        sort = undefined;
    }

    // a price FILTER or a price SORT compares the bare integer `priceAmount`, so
    // it must be scoped to a SINGLE currency — otherwise a ¥ integer and a € integer get
    // compared as if commensurable. Use the explicit `currency` param, else the tenant's
    // default currency. A query with NO price dimension stays currency-agnostic so single-
    // currency stores (the v1 norm) are unaffected.
    const usesPrice =
      (dto.minPrice !== undefined && dto.minPrice > 0) ||
      (dto.maxPrice !== undefined && dto.maxPrice > 0) ||
      dto.sort === 'price_asc' ||
      dto.sort === 'price_desc';
    if (usesPrice) {
      let currency = dto.currency;
      if (!currency) {
        const profile = await this.settings.getOnboardingProfile(tenantId);
        currency = profile.defaultCurrency ?? undefined;
      }
      if (currency) {
        filterParts.push(`currency = "${escapeFilterValue(currency)}"`);
      }
    }

    // `filterParts` always has at least the tenant clause, so `filter` is always set.
    const filter: Filter = filterParts as unknown as Filter;

    // ── Pagination ─────────────────────────────────────────────────────────────
    const page = dto.page ?? 1;
    const pageSize = dto.pageSize ?? 20;
    const hitsPerPage = pageSize;
    const meilisearchPage = page; // Meilisearch pages are 1-based

    const params: SearchParams = {
      filter,
      sort,
      hitsPerPage,
      page: meilisearchPage,
      facets: ['categorySlugs', 'priceAmount'],
    };

    const t0 = Date.now();
    let result;
    try {
      result = await client.index(indexName).search(dto.q ?? '', params);
    } catch (err) {
      // If the index doesn't exist yet (no products created), return empty result.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('index_not_found') || msg.includes('not found')) {
        return {
          hits: [],
          facets: { categories: [], price: null },
          page,
          pageSize,
          total: 0,
          processingTimeMs: Date.now() - t0,
        };
      }
      this.logger.error(`[search] query failed — tenantId=${tenantId}: ${msg}`);
      throw err;
    }

    // ── Map hits to allowlisted cards ──────────────────────────────────────────
    const hits: SearchProductCard[] = (result.hits as RawHit[]).map((h) => mapHitToCard(h));

    // ── Assemble facets ────────────────────────────────────────────────────────
    const facetDist = result.facetDistribution ?? {};
    const categoryFacets: CategoryFacet[] = [];
    if (facetDist['categorySlugs']) {
      for (const [slug, count] of Object.entries(
        facetDist['categorySlugs'] as Record<string, number>,
      )) {
        // We only have slug in facet distribution; name lookup is omitted here
        // (would require a DB call per facet slug; v1 returns slug as name fallback).
        categoryFacets.push({ slug, name: slug, count });
      }
    }

    // F4 (Fable): use Meilisearch's numeric facetStats for the TRUE min/max.
    // Deriving from facetDistribution keys is capped at maxValuesPerFacet (100),
    // so it reports the wrong min/max once a tenant has >100 distinct prices.
    let priceStats: PriceFacetStats | null = null;
    const priceFacetStat = result.facetStats?.['priceAmount'];
    if (priceFacetStat) {
      priceStats = { min: priceFacetStat.min, max: priceFacetStat.max };
    }

    return {
      hits,
      facets: { categories: categoryFacets, price: priceStats },
      page,
      pageSize,
      total:
        ((result as Record<string, unknown>)['totalHits'] as number | undefined) ??
        result.estimatedTotalHits ??
        hits.length,
      processingTimeMs: result.processingTimeMs ?? Date.now() - t0,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Map a raw Meilisearch hit to the allowlisted card shape. */
function mapHitToCard(h: RawHit): SearchProductCard {
  return {
    id: String(h['id'] ?? ''),
    title: String(h['title'] ?? ''),
    slug: String(h['slug'] ?? ''),
    description: h['description'] != null ? String(h['description']) : null,
    thumbnailUrl: String(h['thumbnailUrl'] ?? ''),
    priceAmount: typeof h['priceAmount'] === 'number' ? h['priceAmount'] : 0,
    currency: String(h['currency'] ?? ''),
    availability: Boolean(h['availability']),
    categorySlugs: Array.isArray(h['categorySlugs'])
      ? (h['categorySlugs'] as unknown[]).map(String)
      : [],
    categoryNames: Array.isArray(h['categoryNames'])
      ? (h['categoryNames'] as unknown[]).map(String)
      : [],
    tagSlugs: Array.isArray(h['tagSlugs']) ? (h['tagSlugs'] as unknown[]).map(String) : [],
    tagNames: Array.isArray(h['tagNames']) ? (h['tagNames'] as unknown[]).map(String) : [],
  };
}

/** Escape a string value used inside a Meilisearch filter expression. */
function escapeFilterValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
