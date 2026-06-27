/**
 * WS-3d — Marketing sections data loader.
 *
 * Fetches `GET /store/v1/storefront/home-sections` via the SSR store client and re-validates
 * each entry with `parseMarketingSection` (defence in depth — the API has already validated, but
 * the storefront re-validates at its boundary before rendering merchant-authored content).
 *
 * Graceful degrade: ANY failure (API unreachable / non-200 / non-array response / network error)
 * returns `[]` — the home page must never 500 because the marketing API is cold or returns garbage.
 * Invalid individual entries are dropped silently (parseMarketingSection returns null → skip).
 *
 * Raw wire type: `{ sections: unknown[], updatedAt: string }` — we treat the sections array
 * as `unknown[]` and validate each entry, never trusting the shape.
 */
import { createStoreClient } from './store-client';
import { parseMarketingSection, type MarketingSectionDescriptor } from '@sovecom/theme-sdk';

/** Raw API wire shape — we only trust it after per-entry validation. */
interface RawHomeSectionsResponse {
  sections: unknown[];
  updatedAt: string;
}

/**
 * Fetch and validate the home-page marketing sections from the store API.
 *
 * Returns an ordered array of validated `MarketingSectionDescriptor`s, or `[]` when:
 *   - The API is unreachable or returns a non-200 (transport error / ECONNREFUSED).
 *   - The response body is not the expected shape.
 *   - All entries are invalid / unknown type.
 *
 * Never throws — the home page render path must be resilient.
 */
export async function fetchMarketingSections(): Promise<MarketingSectionDescriptor[]> {
  try {
    const client = createStoreClient();
    const raw = await client.request<
      '/store/v1/storefront/home-sections',
      'get',
      RawHomeSectionsResponse
    >('get', '/store/v1/storefront/home-sections');

    // Defensive: the response must be a plain object with a sections array.
    if (
      !raw ||
      typeof raw !== 'object' ||
      !Array.isArray((raw as RawHomeSectionsResponse).sections)
    ) {
      return [];
    }

    const { sections } = raw as RawHomeSectionsResponse;

    // Re-validate each entry (defence in depth). parseMarketingSection returns null on ANY failure
    // (unknown type, schema violation, etc.) — those entries are silently dropped.
    const validated: MarketingSectionDescriptor[] = [];
    for (const entry of sections) {
      const parsed = parseMarketingSection(entry);
      if (parsed !== null) validated.push(parsed);
    }

    return validated;
  } catch {
    // API cold / ECONNREFUSED / network error / non-200 → degrade to empty list.
    // The home page renders without the marketing block rather than throwing.
    return [];
  }
}
