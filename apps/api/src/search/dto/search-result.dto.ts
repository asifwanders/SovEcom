/**
 * SearchResultDto (allowlist).
 *
 * Defines the shape of a store search card. Only the fields declared here are
 * ever in the response — this is the allowlist that prevents accidental leakage
 * of internal fields (embedding, metadata, tenantId, cost, etc.).
 *
 * Facets include category hit-counts and price stats.
 */

export interface SearchProductCard {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  thumbnailUrl: string;
  /** Minimum variant price in integer cents. */
  priceAmount: number;
  currency: string;
  /** True if any variant is in stock or allows backorder. */
  availability: boolean;
  categorySlugs: string[];
  categoryNames: string[];
  tagSlugs: string[];
  tagNames: string[];
}

export interface CategoryFacet {
  slug: string;
  name: string;
  count: number;
}

export interface PriceFacetStats {
  min: number;
  max: number;
}

export interface SearchFacets {
  categories: CategoryFacet[];
  price: PriceFacetStats | null;
}

export interface SearchResultDto {
  hits: SearchProductCard[];
  facets: SearchFacets;
  page: number;
  pageSize: number;
  total: number;
  processingTimeMs: number;
}
