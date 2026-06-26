/**
 * recently-viewed — the HTTP handlers behind `sdk.serve`.
 *
 * Routes (mounted by core under `/store/v1/modules/recently-viewed/*`):
 *   POST /views          body { productId }       → record/refresh a view for the viewer
 *   GET  /recent         ?exclude=<id>            → the viewer's most-recently-viewed products
 *   POST /merge-guest                             → migrate guest history to the logged-in customer
 *
 * VIEWER SCOPING (security): every route resolves the viewer ONLY via {@link resolveViewer} — the
 * core-VERIFIED `req.customer.id` for a logged-in shopper, else the core-VERIFIED `req.guestId.id`
 * from the signed sov_guest httpOnly cookie. The viewer key is NEVER taken from a free body field,
 * query, or header. Because every SQL statement binds that key as `viewer_key`, viewer A can never
 * see or mutate viewer B's history. When no viewer can be resolved, a write returns 401 and a read
 * returns an empty list. See README "Guest identity" for details.
 *
 * The handlers are pure over an injected SDK + repository + seams, so they unit-test against a
 * mocked SDK.
 */
import type { ModuleHttpRequest, ModuleHttpResponse, StoreClient } from '@sovecom/module-sdk';
import type { RecentlyViewedRepository, ViewRow } from '../db/repository';
import type { RecentlyViewedSettings } from '../settings';
import { resolveViewer } from '../identity/viewer';
import { isExcludedByCategory, type ProductCategoryResolver } from '../category/category-filter';
import { handleRecentlyViewedSlot } from '../slot/recently-viewed-slot';

/** JSON response helper — always declares a safe content-type (core re-asserts it anyway). */
function json(status: number, body: unknown): ModuleHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** A true bodyless 204 — RFC 7230 forbids a body (and thus a content-type) on a 204. */
function noContent(): ModuleHttpResponse {
  return { status: 204 };
}

/** Parse the request body as JSON; returns undefined on any failure (caller maps to 400). */
function parseBody(req: ModuleHttpRequest): Record<string, unknown> | undefined {
  if (typeof req.body !== 'string' || req.body.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(req.body);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Forbidden control characters in an id (C0 range + DEL). A NUL/control char would otherwise reach a
 * bound SQL param and PostgreSQL rejects an embedded NUL, surfacing as an unhandled 500. Reject it
 * here so a bad id is a clean 400. Hex escapes only — no raw control bytes in source.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\x00-\x1f\x7f]/;

/** A bound, non-empty id string: trimmed, length-checked, and free of control characters. */
function readId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return undefined;
  if (FORBIDDEN_CONTROL.test(v)) return undefined;
  return v;
}

/** First value for a query key (the query may carry repeated keys → string[]). */
function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface HandlerDeps {
  readonly repo: RecentlyViewedRepository;
  /** Gated `read:products` catalog read — used to enrich the list + (optionally) verify existence. */
  readonly products: StoreClient['products'];
  /** The `excludeCategories` resolution seam (see category/category-filter.ts). */
  readonly categoryResolver: ProductCategoryResolver;
  readonly settings: RecentlyViewedSettings;
  /**
   * When true, POST /views verifies the product exists (gated read:products) and 404s an unknown
   * product. Defaults to false: recording a view is a cheap, low-stakes signal and a stale/unknown
   * id simply never enriches on read — but the integration suite flips this on to drive the
   * existence guard end-to-end.
   */
  readonly verifyProductExists?: boolean;
}

/**
 * Handle one mounted request. Returns the {@link ModuleHttpResponse} core will bound + serve.
 * Unmatched method/path → 404; disabled module → 404. This module has NO admin surface, so an admin
 * request matches nothing → 404.
 */
export async function handleRequest(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
): Promise<ModuleHttpResponse> {
  // Feature flag: a disabled module behaves as if it had no endpoints.
  if (!deps.settings.enabled) return json(404, { error: 'not_found' });

  // No admin surface — the recently-viewed feature is entirely store-facing.
  if (req.surface === 'admin') return json(404, { error: 'not_found' });

  const path = req.path;
  const method = req.method.toUpperCase();

  // POST /views — record a view
  if (method === 'POST' && (path === '/views' || path === '/views/')) {
    return recordView(req, deps);
  }
  // POST /merge-guest — migrate guest history to the authenticated customer.
  if (method === 'POST' && (path === '/merge-guest' || path === '/merge-guest/')) {
    return mergeGuest(req, deps);
  }
  // GET /recent — list the viewer's recently viewed products
  if (method === 'GET' && (path === '/recent' || path === '/recent/')) {
    return listRecent(req, deps);
  }
  // GET /slot?slot=&route= — the slot DATA mount (product-carousel widget descriptor).
  if (method === 'GET' && (path === '/slot' || path === '/slot/')) {
    return handleRecentlyViewedSlot(req, deps.repo, deps.products);
  }

  return json(404, { error: 'not_found' });
}

async function recordView(req: ModuleHttpRequest, deps: HandlerDeps): Promise<ModuleHttpResponse> {
  // A view is personal to a viewer, so it needs a viewer key (account id or guest token).
  const viewer = resolveViewer(req);
  if (viewer.kind === 'none') return json(401, { error: 'login_required' });

  const body = parseBody(req);
  const productId = readId(body?.productId);
  if (!productId) return json(400, { error: 'invalid_product_id' });

  // Optional existence guard (gated read:products). A failed lookup degrades to "not found" rather
  // than a 500 — you cannot meaningfully record a view of a product the catalog does not have.
  if (deps.verifyProductExists) {
    let exists: boolean;
    try {
      exists = (await deps.products.get(productId)) !== null;
    } catch {
      exists = false;
    }
    if (!exists) return json(404, { error: 'product_not_found' });
  }

  await deps.repo.recordView(viewer.key, productId);
  return noContent();
}

/**
 * The viewer's most-recently-viewed products, newest first, capped at `maxItems`, with the
 * `?exclude` product and any `excludeCategories` product filtered out, then enriched via the gated
 * `read:products` surface. An unresolved viewer simply has no history → an empty list (not a 401:
 * a read leaks nothing and a guestless storefront can still render an empty rail).
 */
async function listRecent(req: ModuleHttpRequest, deps: HandlerDeps): Promise<ModuleHttpResponse> {
  const viewer = resolveViewer(req);
  if (viewer.kind === 'none') return json(200, { items: [] });

  // An invalid `?exclude` (empty / over-long / control chars) degrades to undefined → no exclusion,
  // by design: the rail still renders, it just may include the on-screen product. Availability wins.
  const excludeProductId = readId(firstQuery(req.query.exclude));
  const maxItems = deps.settings.maxItems;

  // OVER-FETCH so category exclusion (a post-read filter, see category-filter.ts) can still yield up
  // to `maxItems` survivors. We cap the over-fetch generously but boundedly (never unbounded).
  const overFetch = Math.min(maxItems * 4, 200);
  const rows = await deps.repo.recent(viewer.key, overFetch, excludeProductId);

  // Drop products whose category is excluded (resolver seam), preserving newest-first order, then cap.
  const kept: ViewRow[] = [];
  for (const row of rows) {
    const excluded = await isExcludedByCategory(
      row.product_id,
      deps.settings.excludeCategories,
      deps.categoryResolver,
    );
    if (!excluded) kept.push(row);
    if (kept.length >= maxItems) break;
  }

  const items = await enrich(kept, deps.products);
  return json(200, { items });
}

/**
 * POST /merge-guest — Migrate a guest's recently-viewed history to the authenticated customer.
 *
 * SECURITY: this endpoint REQUIRES a verified customer (Bearer JWT). The guestId to merge is
 * read from `req.guestId` (the core-derived guest identity from the sov_guest cookie) — NEVER
 * from the request body. This prevents a customer from merging an arbitrary guest's data by
 * supplying a fabricated guestId.
 *
 * The storefront calls this immediately after login succeeds (credentials:'include' carries the
 * sov_guest cookie automatically). After the merge, subsequent requests use the customer's Bearer
 * token and the guest history rows have been migrated to the customer's viewer key.
 */
async function mergeGuest(req: ModuleHttpRequest, deps: HandlerDeps): Promise<ModuleHttpResponse> {
  // Must be a logged-in customer to merge.
  const customerId = req.customer?.id;
  if (typeof customerId !== 'string' || customerId.length === 0) {
    return json(401, { error: 'login_required' });
  }

  // The guestId comes from the core-verified sov_guest cookie (NOT from the body).
  const guestId = req.guestId?.id;
  if (typeof guestId !== 'string' || guestId.length === 0) {
    // No guest cookie present — nothing to merge. Return 200 (idempotent).
    return json(200, { merged: 0 });
  }

  const merged = await deps.repo.mergeGuestToCustomer(guestId, customerId);
  return json(200, { merged });
}

/**
 * Enrich kept rows with catalog info via the gated `read:products` read. The field-limited
 * `ModuleProductDto` carries no price (price is not exposed to modules). Enrichment is best-effort:
 * a product that is gone (deleted/unpublished) or fails to load degrades to `product: null` — the
 * recently-viewed entry still lists with its product id, preserving order.
 *
 * One `products.get` per kept row (N+1). Acceptable: the kept set is bounded by `maxItems` (<= 50),
 * the calls run concurrently (`Promise.all`), and the read surface exposes no batch-get.
 */
async function enrich(
  rows: readonly ViewRow[],
  products: StoreClient['products'],
): Promise<
  Array<{
    productId: string;
    viewedAt: string;
    product: { id: string; slug: string; title: string; status: string } | null;
  }>
> {
  return Promise.all(
    rows.map(async (row) => {
      let product: { id: string; slug: string; title: string; status: string } | null = null;
      try {
        const dto = await products.get(row.product_id);
        if (dto) {
          product = { id: dto.id, slug: dto.slug, title: dto.title, status: dto.status };
        }
      } catch {
        product = null;
      }
      return { productId: row.product_id, viewedAt: row.viewed_at, product };
    }),
  );
}
