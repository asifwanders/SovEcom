/**
 * wishlist -- the HTTP handlers behind `sdk.serve`.
 *
 * Routes (mounted by core under `/store/v1/modules/wishlist/*`):
 *   POST   /items              body { productVariantId }  -> add to the caller's wishlist
 *   DELETE /items/:id          (path = the product variant id)  -> remove
 *   GET    /items              -> list the caller's wishlist, enriched with product info
 *   POST   /items/:id/add      bodyless toggle alias (add)
 *   POST   /items/:id/remove   bodyless toggle alias (remove)
 *   GET    /slot?slot=&route=  -> slot DATA mount (toggle-button widget descriptor)
 *   POST   /merge-guest        body { guestId } -> merge guest wishlist into customer wishlist
 *
 * IDENTITY (security): every route resolves the buyer identity via {@link resolveViewer}:
 *   - Logged-in customers: `req.customer.id` (core-VERIFIED from JWT).
 *   - Anonymous guests: `req.guestId.id` (core-VERIFIED from HMAC-signed sov_guest cookie).
 * Neither is EVER taken from the request body, query, or headers. A module cannot be made
 * to trust a spoofed identity.
 *
 * GUEST WRITES: Guests may add/remove items from their guest wishlist. The data is stored
 * separately in `mod_wishlist_guest_items` (not the customer table). On login, the storefront
 * calls `POST /merge-guest` (with the customer's Bearer token) and the guest rows are migrated
 * to the customer table (idempotent, dedupe-safe).
 *
 * The handlers are pure over an injected SDK + repository, so they unit-test against a
 * mocked SDK.
 */
import type { ModuleHttpRequest, ModuleHttpResponse, StoreClient } from '@sovecom/module-sdk';
import type { WishlistRepository } from '../db/repository';
import type { WishlistSettings } from '../settings';
import { resolveViewer } from '../identity/viewer';
import { handleWishlistSlot } from '../slot/wishlist-slot';

/** JSON response helper -- always declares a safe content-type (core re-asserts it anyway). */
function json(status: number, body: unknown): ModuleHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** A true bodyless 204 -- RFC 7230 forbids a body (and thus a content-type) on a 204. */
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
 * Forbidden bytes in an id: any control char (C0 + DEL) or a path separator (`/`, `\`). A direct API
 * caller could POST `/items/%2Fetc%2Fpasswd/remove` -- after decodeURIComponent the id would contain a
 * slash; SQL is parameterized so it is harmless TODAY, but a decoded id that smuggles a separator or a
 * control byte is never a legitimate product/variant id -- reject it at the boundary. Hex escapes only.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_ID_CHARS = /[\x00-\x1f\x7f/\\]/;

/** A bound, non-empty string field: trimmed, length-checked, free of control/path-separator chars. */
function readId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return undefined;
  if (FORBIDDEN_ID_CHARS.test(v)) return undefined;
  return v;
}

/** Extract the trailing `:id` segment from a `/items/<id>` path. */
function variantIdFromPath(path: string): string | undefined {
  const m = /^\/items\/([^/]+)\/?$/.exec(path);
  if (!m) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(m[1]!);
  } catch {
    return undefined;
  }
  return readId(decoded);
}

/**
 * Match the path-based toggle aliases `POST /items/<id>/add` | `POST /items/<id>/remove` and return
 * `{ id, action }`. These back the `toggle-button` slot widget, which POSTs with no body.
 */
function toggleAliasFromPath(path: string): { id: string; action: 'add' | 'remove' } | undefined {
  const m = /^\/items\/([^/]+)\/(add|remove)\/?$/.exec(path);
  if (!m) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(m[1]!);
  } catch {
    return undefined;
  }
  const id = readId(decoded);
  if (!id) return undefined;
  return { id, action: m[2] as 'add' | 'remove' };
}

export interface HandlerDeps {
  readonly repo: WishlistRepository;
  readonly store: StoreClient;
  readonly settings: WishlistSettings;
}

/**
 * Handle one mounted request. Returns the {@link ModuleHttpResponse} core will bound + serve.
 * Unmatched method/path -> 404; disabled module -> 404.
 */
export async function handleRequest(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
): Promise<ModuleHttpResponse> {
  if (!deps.settings.enabled) return json(404, { error: 'not_found' });

  const path = req.path;
  const method = req.method.toUpperCase();

  // POST /items -- add (body { productVariantId })
  if (method === 'POST' && (path === '/items' || path === '/items/')) {
    return addItem(req, deps);
  }
  // POST /items/:id/add | /items/:id/remove -- bodyless toggle aliases (slot widget).
  if (method === 'POST') {
    const toggle = toggleAliasFromPath(path);
    if (toggle) {
      return toggle.action === 'add'
        ? addItemById(req, deps, toggle.id)
        : removeItem(req, deps, toggle.id);
    }
    // POST /merge-guest -- migrate a guest wishlist to the authenticated customer.
    if (path === '/merge-guest' || path === '/merge-guest/') {
      return mergeGuest(req, deps);
    }
  }
  // GET /items -- list
  if (method === 'GET' && (path === '/items' || path === '/items/')) {
    return listItems(req, deps);
  }
  // GET /slot?slot=&route= -- the slot DATA mount (toggle-button widget descriptor).
  if (method === 'GET' && (path === '/slot' || path === '/slot/')) {
    return handleWishlistSlot(req, deps.repo);
  }
  // DELETE /items/:variantId -- remove
  if (method === 'DELETE') {
    const variantId = variantIdFromPath(path);
    if (variantId) return removeItem(req, deps, variantId);
  }

  return json(404, { error: 'not_found' });
}

/**
 * The shared add path for CUSTOMERS: idempotent, cap-gated.
 * Used by both `POST /items` (body-supplied id) and the bodyless toggle alias `POST /items/:id/add`.
 */
async function performCustomerAdd(
  deps: HandlerDeps,
  customerId: string,
  productVariantId: string,
): Promise<ModuleHttpResponse> {
  const already = await deps.repo.has(customerId, productVariantId);
  if (!already) {
    const count = await deps.repo.countForCustomer(customerId);
    if (count >= deps.settings.maxItemsPerCustomer) {
      return json(409, {
        error: 'max_items_reached',
        maxItemsPerCustomer: deps.settings.maxItemsPerCustomer,
      });
    }
  }
  const row = await deps.repo.add(customerId, productVariantId);
  return json(already ? 200 : 201, {
    id: row.id,
    productVariantId: row.product_variant_id,
    createdAt: row.created_at,
  });
}

/**
 * The shared add path for GUESTS: idempotent, cap-gated.
 * Stores in `mod_wishlist_guest_items` (separate from customer items until merge-on-login).
 */
async function performGuestAdd(
  deps: HandlerDeps,
  guestId: string,
  productVariantId: string,
): Promise<ModuleHttpResponse> {
  const already = await deps.repo.guestHas(guestId, productVariantId);
  if (!already) {
    const count = await deps.repo.countForGuest(guestId);
    if (count >= deps.settings.maxItemsPerCustomer) {
      return json(409, {
        error: 'max_items_reached',
        maxItemsPerCustomer: deps.settings.maxItemsPerCustomer,
      });
    }
  }
  const row = await deps.repo.guestAdd(guestId, productVariantId);
  return json(already ? 200 : 201, {
    id: row.id,
    productVariantId: row.product_variant_id,
    createdAt: row.created_at,
  });
}

async function addItem(req: ModuleHttpRequest, deps: HandlerDeps): Promise<ModuleHttpResponse> {
  const viewer = resolveViewer(req);
  if (viewer.kind === 'none') return json(401, { error: 'login_required' });

  const body = parseBody(req);
  const productVariantId = readId(body?.productVariantId);
  if (!productVariantId) {
    return json(400, { error: 'invalid_product_variant_id' });
  }

  if (viewer.kind === 'customer') {
    // Strip the 'cust:' prefix to get the raw customer id.
    const customerId = req.customer!.id;
    return performCustomerAdd(deps, customerId, productVariantId);
  } else {
    // viewer.kind === 'guest'
    const guestId = req.guestId!.id;
    return performGuestAdd(deps, guestId, productVariantId);
  }
}

/** Bodyless toggle alias `POST /items/:id/add` -- the id is path-supplied, already validated. */
async function addItemById(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
  productVariantId: string,
): Promise<ModuleHttpResponse> {
  const viewer = resolveViewer(req);
  if (viewer.kind === 'none') return json(401, { error: 'login_required' });

  if (viewer.kind === 'customer') {
    return performCustomerAdd(deps, req.customer!.id, productVariantId);
  } else {
    return performGuestAdd(deps, req.guestId!.id, productVariantId);
  }
}

async function removeItem(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
  productVariantId: string,
): Promise<ModuleHttpResponse> {
  const viewer = resolveViewer(req);
  if (viewer.kind === 'none') return json(401, { error: 'login_required' });

  let removed: boolean;
  if (viewer.kind === 'customer') {
    removed = await deps.repo.remove(req.customer!.id, productVariantId);
  } else {
    removed = await deps.repo.guestRemove(req.guestId!.id, productVariantId);
  }
  return removed ? noContent() : json(404, { error: 'not_found' });
}

async function listItems(req: ModuleHttpRequest, deps: HandlerDeps): Promise<ModuleHttpResponse> {
  const viewer = resolveViewer(req);
  if (viewer.kind === 'none') return json(401, { error: 'login_required' });

  if (viewer.kind === 'customer') {
    const rows = await deps.repo.list(req.customer!.id);
    const items = await enrichCustomerItems(rows, deps.store);
    return json(200, { items });
  } else {
    const rows = await deps.repo.guestList(req.guestId!.id);
    const items = await enrichGuestItems(rows, deps.store);
    return json(200, { items });
  }
}

/**
 * POST /merge-guest -- Migrate a guest's wishlist to the authenticated customer.
 *
 * SECURITY: this endpoint REQUIRES a verified customer (Bearer JWT). The guestId to merge
 * is read from `req.guestId` (the core-derived guest identity from the sov_guest cookie) --
 * never from the request body. This prevents a customer from merging an arbitrary guest's
 * data by supplying a different guestId.
 *
 * The storefront calls this immediately after login succeeds (before the next module request),
 * passing its current sov_guest cookie along (credentials:'include'). After the merge, the
 * storefront's subsequent module requests will use the customer's Bearer token and the guest
 * wishlist rows will have been migrated to the customer table.
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
    // No guest cookie present -- nothing to merge. Return 200 (idempotent).
    return json(200, { merged: 0 });
  }

  const merged = await deps.repo.mergeGuestToCustomer(guestId, customerId);
  return json(200, { merged });
}

/**
 * Enrich customer wishlist rows with catalog info via the gated `read:products` surface.
 * Best-effort: a deleted/unpublished product degrades to `product: null`.
 */
async function enrichCustomerItems(
  rows: ReadonlyArray<{ id: string; product_variant_id: string; created_at: string }>,
  store: StoreClient,
): Promise<
  Array<{
    id: string;
    productVariantId: string;
    createdAt: string;
    product: { id: string; slug: string; title: string; status: string } | null;
  }>
> {
  return Promise.all(
    rows.map(async (row) => {
      let product: { id: string; slug: string; title: string; status: string } | null = null;
      try {
        const dto = await store.products.get(row.product_variant_id);
        if (dto) {
          product = { id: dto.id, slug: dto.slug, title: dto.title, status: dto.status };
        }
      } catch {
        product = null;
      }
      return {
        id: row.id,
        productVariantId: row.product_variant_id,
        createdAt: row.created_at,
        product,
      };
    }),
  );
}

/**
 * Enrich guest wishlist rows with catalog info. Same best-effort behaviour as customer
 * enrichment.
 */
async function enrichGuestItems(
  rows: ReadonlyArray<{ id: string; product_variant_id: string; created_at: string }>,
  store: StoreClient,
): Promise<
  Array<{
    id: string;
    productVariantId: string;
    createdAt: string;
    product: { id: string; slug: string; title: string; status: string } | null;
  }>
> {
  return enrichCustomerItems(rows, store);
}
