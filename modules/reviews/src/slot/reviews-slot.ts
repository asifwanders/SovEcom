/**
 * reviews — the slot DATA handler. The module returns a typed widget descriptor `{ type, props }`
 * — data only, never code or HTML — over its store mount: `GET /slot?slot=&route=`. The storefront
 * validates it with `parseWidget` and renders its own `review-list` component.
 *
 * This slot is READ-ONLY and ANONYMOUS: it reuses the module's existing approved-only review read
 * (`approvedWithSummary`) — pending/rejected reviews never surface, exactly as the public list does —
 * and emits NO customer id / author (the public read is anonymous by design, repository.PublicReview).
 * The descriptor is bounded to the C1 caps (≤{@link REVIEW_LIST_MAX_ITEMS} items, body
 * ≤{@link REVIEW_BODY_MAX_LEN} code points) so a parseWidget on the other side always accepts it.
 *
 * The `route` is the product id (the storefront threads `product.id`, since the catalog read
 * surface is id-keyed). An unknown slot, missing/invalid route, or disabled module returns 204: the
 * module declines to render and the storefront shows nothing.
 */
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';
import type { ReviewsRepository } from '../db/repository';

/** The slot this module fills (must match `sovecom.module.json` slots[].slot). */
export const REVIEWS_SLOT = 'product-detail-reviews-section';

/** C1 `review-list` caps mirrored here so the descriptor is always within the storefront's contract. */
export const REVIEW_LIST_MAX_ITEMS = 50;
export const REVIEW_BODY_MAX_LEN = 2000;

/** A bound product-id route value (mirrors the handlers' id rule: trimmed, 1–64 chars). */
function readRouteProductId(req: ModuleHttpRequest): string | undefined {
  const raw = req.query.route;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return undefined;
  return v;
}

/** First value for a query key (the query may carry repeated keys → string[]). */
function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** A bodyless 204 — the module declines to render at this slot (RFC 7230: no body on a 204). */
function decline(): ModuleHttpResponse {
  return { status: 204 };
}

/**
 * Map the module's approved-review read to a C1 `review-list` widget descriptor. Bounds the item count
 * and each body to the C1 caps; emits NO author / customer id (anonymous public read).
 */
export async function buildReviewListDescriptor(
  repo: ReviewsRepository,
  productId: string,
): Promise<{
  type: 'review-list';
  props: { items: Array<{ id: string; rating: number; body: string; createdAt: string }> };
}> {
  const { reviews } = await repo.approvedWithSummary(productId);
  const items = reviews.slice(0, REVIEW_LIST_MAX_ITEMS).map((r) => ({
    id: r.id,
    rating: r.rating,
    // Bound the body to the C1 cap (code points), defending the descriptor against an over-long body
    // even if the module's own maxTextLen were configured higher than the storefront contract.
    body: [...r.body].slice(0, REVIEW_BODY_MAX_LEN).join(''),
    createdAt: r.createdAt,
  }));
  return { type: 'review-list', props: { items } };
}

/**
 * Handle `GET /slot`. Returns the `review-list` descriptor for the route's product, or 204 when the
 * slot is unknown / the route is missing/invalid. NEVER returns customer data.
 */
export async function handleReviewsSlot(
  req: ModuleHttpRequest,
  repo: ReviewsRepository,
): Promise<ModuleHttpResponse> {
  if (firstQuery(req.query.slot) !== REVIEWS_SLOT) return decline();
  const productId = readRouteProductId(req);
  if (!productId) return decline();

  const descriptor = await buildReviewListDescriptor(repo, productId);
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(descriptor),
  };
}
