/**
 * SearchQueryDto — public store endpoint.
 *
 * Validates and sanitises all query params. All errors are clamped/defaulted —
 * never a 500 on garbage input (mirrors StoreQueryDto hardening from 1.6).
 *
 * This is a PUBLIC URL, so it must NOT `.strict()`. Shared/store links
 * routinely carry tracking junk (`utm_source`, `fbclid`, `gclid`, …). `.strict()`
 * would 400 those; zod's default behaviour STRIPS unknown keys, so we keep the
 * clamping but silently ignore extra params instead of rejecting the request.
 *
 * sort values:
 *   relevance  — Meilisearch natural relevance (default)
 *   price_asc  — priceAmount ascending
 *   price_desc — priceAmount descending
 *   newest     — createdAt descending
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const SearchQuerySchema = z
  .object({
    /** Full-text search query. Optional — empty/absent returns all docs. */
    q: z.string().max(512).optional().default(''),

    /** Filter by category slug. */
    category: z.string().max(256).optional(),

    /** Filter by tag slug. */
    tag: z.string().max(256).optional(),

    /** Minimum price in integer cents (inclusive). Clamped to ≥ 0. */
    minPrice: z.coerce.number().int().min(0).catch(0).optional(),

    /** Maximum price in integer cents (inclusive). Clamped to ≥ 0. */
    maxPrice: z.coerce.number().int().min(0).catch(0).optional(),

    /**
     * Currency (ISO 4217) to scope a price filter/sort to. When a price
     * dimension is used the query is constrained to ONE currency so integer prices are
     * never compared across currencies; defaults to the store's default currency when
     * omitted. A malformed value is stripped (this is a public URL — never 500).
     */
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/)
      .transform((c) => c.toUpperCase())
      .catch(undefined as unknown as string)
      .optional(),

    /** Sort order. Defaults to relevance. */
    sort: z
      .enum(['relevance', 'price_asc', 'price_desc', 'newest'])
      .catch('relevance')
      .default('relevance'),

    /** 1-based page number. Clamped to ≥ 1. */
    page: z.coerce.number().int().min(1).catch(1).default(1),

    /** Results per page. Clamped to 1–100. */
    pageSize: z.coerce.number().int().min(1).max(100).catch(20).default(20),
  })
  // NOT .strict(): unknown query params (utm_source, fbclid, gclid, …) are
  // stripped, not rejected — see the note in the file header.
  .strip();

export class SearchQueryDto extends createZodDto(SearchQuerySchema) {}
