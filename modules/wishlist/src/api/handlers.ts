/**
 * wishlist — the HTTP handlers behind `sdk.serve`.
 *
 * Routes (mounted by core under `/store/v1/modules/wishlist/*`):
 *   POST   /items        body { productVariantId }  → add to the caller's wishlist
 *   DELETE /items/:id    (path = the product variant id)  → remove from the caller's wishlist
 *   GET    /items        → list the caller's wishlist, enriched with product info
 *
 * CUSTOMER SCOPING (security): every route reads the buyer identity ONLY from `req.customer.id` —
 * the core-VERIFIED principal the store proxy set from a customer JWT it checked itself (3.10-i.5).
 * It is NEVER taken from the body, query, or headers. When `req.customer` is absent (anonymous /
 * no token) a write/read of personal data returns 401 — the module requires login.
 * Because the id is core-verified and every SQL statement binds it as a parameter, customer A can
 * never see or mutate customer B's items.
 *
 * The handlers are pure over an injected SDK + repository, so they unit-test against a mocked SDK.
 */
import type { ModuleHttpRequest, ModuleHttpResponse, StoreClient } from '@sovecom/module-sdk';
import type { WishlistRepository } from '../db/repository';
import type { WishlistSettings } from '../settings';
import { handleWishlistSlot } from '../slot/wishlist-slot';

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
 * Forbidden bytes in an id: any control char (C0 + DEL) or a path separator (`/`, `\`). A direct API
 * caller could POST `/items/%2Fetc%2Fpasswd/remove` → after decodeURIComponent the id would contain a
 * slash; SQL is parameterized so it is harmless TODAY, but a decoded id that smuggles a separator or a
 * control byte is never a legitimate product/variant id — reject it at the boundary. Hex escapes only.
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
  // A malformed percent-escape (e.g. `/items/%zz`) makes decodeURIComponent throw URIError. Treat
  // it as a non-match (→ 404) rather than letting it bubble to an unhandled 500.
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
 * `{ id, action }`. These back the `toggle-button` slot widget, which POSTs with no body — so
 * the product id rides in the path instead of the JSON body that `POST /items` uses. The DELETE
 * `/items/:id` remove is retained for non-widget callers.
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
 * Unmatched method/path → 404; disabled module → 404; anonymous on a customer route → 401.
 */
export async function handleRequest(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
): Promise<ModuleHttpResponse> {
  // Feature flag: a disabled module behaves as if it had no endpoints.
  if (!deps.settings.enabled) return json(404, { error: 'not_found' });

  const path = req.path;
  const method = req.method.toUpperCase();

  // POST /items — add (body { productVariantId })
  if (method === 'POST' && (path === '/items' || path === '/items/')) {
    return addItem(req, deps);
  }
  // POST /items/:id/add | /items/:id/remove — bodyless toggle aliases (slot widget).
  if (method === 'POST') {
    const toggle = toggleAliasFromPath(path);
    if (toggle) {
      return toggle.action === 'add'
        ? addItemById(req, deps, toggle.id)
        : removeItem(req, deps, toggle.id);
    }
  }
  // GET /items — list
  if (method === 'GET' && (path === '/items' || path === '/items/')) {
    return listItems(req, deps);
  }
  // GET /slot?slot=&route= — the slot DATA mount (toggle-button widget descriptor).
  if (method === 'GET' && (path === '/slot' || path === '/slot/')) {
    return handleWishlistSlot(req, deps.repo);
  }
  // DELETE /items/:variantId — remove
  if (method === 'DELETE') {
    const variantId = variantIdFromPath(path);
    if (variantId) return removeItem(req, deps, variantId);
  }

  return json(404, { error: 'not_found' });
}

/** The verified customer id for this request, or null when the caller is anonymous. */
function requireCustomerId(req: ModuleHttpRequest): string | null {
  const id = req.customer?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * The shared add path: idempotent, cap-gated. Used by both `POST /items` (body-supplied id) and the
 * bodyless toggle alias `POST /items/:id/add` (path-supplied id).
 *
 * NOTE (best-effort cap): this has()→count()→add() is check-then-act and NOT atomic — two concurrent
 * adds for the same customer can both pass the count gate and reach cap+1. That is an acceptable soft
 * cap for a wishlist; a hard cap would need DB-side enforcement. The UNIQUE(customer_id, variant)
 * constraint still prevents duplicate ROWS regardless of races.
 */
async function performAdd(
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

async function addItem(req: ModuleHttpRequest, deps: HandlerDeps): Promise<ModuleHttpResponse> {
  const customerId = requireCustomerId(req);
  if (!customerId) return json(401, { error: 'login_required' });

  const body = parseBody(req);
  const productVariantId = readId(body?.productVariantId);
  if (!productVariantId) {
    return json(400, { error: 'invalid_product_variant_id' });
  }

  return performAdd(deps, customerId, productVariantId);
}

/** Bodyless toggle alias `POST /items/:id/add` — the id is path-supplied, already validated. */
async function addItemById(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
  productVariantId: string,
): Promise<ModuleHttpResponse> {
  const customerId = requireCustomerId(req);
  if (!customerId) return json(401, { error: 'login_required' });
  return performAdd(deps, customerId, productVariantId);
}

async function removeItem(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
  productVariantId: string,
): Promise<ModuleHttpResponse> {
  const customerId = requireCustomerId(req);
  if (!customerId) return json(401, { error: 'login_required' });

  const removed = await deps.repo.remove(customerId, productVariantId);
  return removed ? noContent() : json(404, { error: 'not_found' });
}

async function listItems(req: ModuleHttpRequest, deps: HandlerDeps): Promise<ModuleHttpResponse> {
  const customerId = requireCustomerId(req);
  if (!customerId) return json(401, { error: 'login_required' });

  const rows = await deps.repo.list(customerId);
  const items = await enrichItems(rows, deps.store);
  return json(200, { items });
}

/**
 * Enrich stored rows with catalog info via the gated `sdk.store.products` read. The stored id is a
 * product VARIANT id; the catalog read surface is keyed by PRODUCT id, and the field-limited
 * `ModuleProductDto` carries no price (price is not exposed to modules). So enrichment is
 * best-effort: we attach what the store client returns and degrade gracefully when a product is
 * gone (deleted/unpublished) — the wishlist entry still lists with its variant id.
 */
async function enrichItems(
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
        // A failed enrichment must never drop the wishlist entry — leave product null.
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
