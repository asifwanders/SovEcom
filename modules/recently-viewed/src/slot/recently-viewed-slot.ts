/**
 * recently-viewed — the slot DATA handler. The module returns a typed widget descriptor
 * `{ type, props }` — data only, never code or HTML — over its store mount:
 * `GET /slot?slot=home-page-bottom&route=/`. The storefront validates it with `parseWidget`
 * and renders its own `product-carousel` component.
 *
 * VISITOR-SCOPED + READ-ONLY: it resolves the visitor through the module's existing identity seam
 * ({@link resolveViewer} — the core-verified `req.customer.id`, else the high-entropy `x-rv-guest`
 * token), reads that visitor's recent products, enriches them via the gated `read:products` surface,
 * and maps to a `product-carousel`. A product that no longer enriches (deleted/unpublished) is DROPPED
 * (a bad card is never emitted). The descriptor is bounded to the C1 carousel cap
 * ({@link CAROUSEL_MAX_ITEMS}).
 *
 * Fail-closed: an unknown slot, no resolvable visitor, or an empty history ⇒ 204 (decline). The
 * personalized vs. read-only split is the storefront's call; this carousel is treated by C2 as a
 * READ-ONLY widget — it carries no per-customer state beyond the visitor's own history and is
 * route-keyed by the visitor token the storefront supplies. No PII (no email/name) ever crosses.
 */
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';
import type { StoreClient } from '@sovecom/module-sdk';
import type { RecentlyViewedRepository } from '../db/repository';
import { resolveViewer } from '../identity/viewer';

/** The slot this module fills (must match `sovecom.module.json` slots[].slot). */
export const RECENTLY_VIEWED_SLOT = 'home-page-bottom';

/** C1 `product-carousel` item cap mirrored here so the descriptor is always within contract. */
export const CAROUSEL_MAX_ITEMS = 24;

/** First value for a query key (the query may carry repeated keys → string[]). */
function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A bodyless 204 — the module declines to render at this slot. */
function decline(): ModuleHttpResponse {
  return { status: 204 };
}

/** A carousel item is only emitted when its slug is a single inert path segment (C1 traversal guard). */
function safeSlug(slug: string): boolean {
  return slug.length > 0 && !slug.includes('/') && !slug.includes('\\') && slug !== '..';
}

interface CarouselItem {
  productId: string;
  slug: string;
  title: string;
}

/**
 * Build the `product-carousel` items for a visitor: their recent products (bounded), enriched via the
 * gated catalog read, dropping any that no longer enrich or have an unsafe slug.
 */
export async function buildCarouselItems(
  repo: RecentlyViewedRepository,
  products: StoreClient['products'],
  viewerKey: string,
): Promise<CarouselItem[]> {
  // Over-fetch a little past the cap so dropped (un-enrichable) products can still fill the carousel,
  // but stay bounded.
  const rows = await repo.recent(viewerKey, Math.min(CAROUSEL_MAX_ITEMS * 2, 50));
  const items: CarouselItem[] = [];
  for (const row of rows) {
    if (items.length >= CAROUSEL_MAX_ITEMS) break;
    let dto;
    try {
      dto = await products.get(row.product_id);
    } catch {
      dto = null;
    }
    if (!dto) continue; // deleted/unpublished/failed — drop rather than emit a broken card.
    if (!safeSlug(dto.slug)) continue;
    items.push({ productId: dto.id, slug: dto.slug, title: dto.title });
  }
  return items;
}

/**
 * Handle `GET /slot`. Returns the `product-carousel` descriptor for the resolved visitor, or 204 when
 * the slot is unknown / no visitor resolves / the visitor has no (enrichable) history.
 */
export async function handleRecentlyViewedSlot(
  req: ModuleHttpRequest,
  repo: RecentlyViewedRepository,
  products: StoreClient['products'],
): Promise<ModuleHttpResponse> {
  if (firstQuery(req.query.slot) !== RECENTLY_VIEWED_SLOT) return decline();

  const viewer = resolveViewer(req);
  if (viewer.kind === 'none') return decline();

  const items = await buildCarouselItems(repo, products, viewer.key);
  if (items.length === 0) return decline();

  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'product-carousel', props: { items } }),
  };
}
