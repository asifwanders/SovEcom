/**
 * reviews — the HTTP handlers behind `sdk.serve`.
 *
 * Routes (mounted by core; the surface — 'store' (public) vs 'admin' (RBAC-gated) — is on the req):
 *   STORE  POST /reviews            body { productId, rating, body }  → submit a review
 *   STORE  GET  /reviews?productId= → public list of APPROVED reviews + { average, count }
 *   ADMIN  GET  /queue              → pending reviews (moderation queue)
 *   ADMIN  POST /:id/approve        → approve a review (idempotent)
 *   ADMIN  POST /:id/reject         → reject a review (idempotent)
 *
 * SECURITY:
 *   - The submit path takes the buyer identity ONLY from `req.customer.id` — the core-VERIFIED
 *     principal the store proxy set from a customer JWT it checked itself (3.10-i.5). Anonymous →
 *     401. It is NEVER read from the body/query/headers.
 * - The submit path is PURCHASE-GATED via the single {@link hasPurchased} seam. A
 *     non-purchaser → 403 not_purchased. See purchase/purchase-gate.ts for the runtime-gap details.
 *   - The ADMIN surface (queue / approve / reject) is reachable ONLY on `req.surface === 'admin'`
 *     (the core proxy gates that mount behind the admin JWT + `modules:use`). The SAME paths on the
 *     'store' surface are treated as unknown (404), so a public caller can never moderate.
 *
 * The handlers are pure over an injected SDK + repository, so they unit-test against a mocked SDK.
 */
import type {
  ModuleHttpRequest,
  ModuleHttpResponse,
  CommerceClient,
  StoreClient,
} from '@sovecom/module-sdk';
import type { ReviewsRepository } from '../db/repository';
import type { ReviewsSettings } from '../settings';
import { hasPurchased, type PurchaseVerifier } from '../purchase/purchase-gate';
import { validateBody, validateRating } from './validation';
import { handleReviewsSlot } from '../slot/reviews-slot';

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

/** A bound, non-empty id string, trimmed and length-checked (a product / review id). */
function readId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length === 0 || v.length > 64) return undefined;
  return v;
}

/** First value for a query key (the query may carry repeated keys → string[]). */
function firstQuery(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Match an admin moderation path `/:id/approve` or `/:id/reject`; returns { id, action }. */
function moderationFromPath(
  path: string,
): { id: string; action: 'approve' | 'reject' } | undefined {
  const m = /^\/([^/]+)\/(approve|reject)\/?$/.exec(path);
  if (!m) return undefined;
  // A malformed percent-escape (e.g. `/%zz/approve`) makes decodeURIComponent throw URIError. Treat
  // it as a non-match (→ 404) rather than letting it bubble to an unhandled 500.
  let decoded: string;
  try {
    decoded = decodeURIComponent(m[1]!);
  } catch {
    return undefined;
  }
  const id = readId(decoded);
  if (!id) return undefined;
  return { id, action: m[2] as 'approve' | 'reject' };
}

export interface HandlerDeps {
  readonly repo: ReviewsRepository;
  /** Gated `read:products` catalog read — used to reject reviews for a non-existent product. */
  readonly products: StoreClient['products'];
  /** Gated `read:orders` commerce probe — the purchase gate's boolean-only signal (B1). */
  readonly commerce: CommerceClient;
  readonly settings: ReviewsSettings;
  /** Optional purchase verdict override (defaults to the real commerce verifier). */
  readonly purchaseVerifier?: PurchaseVerifier;
}

/**
 * Handle one mounted request. Returns the {@link ModuleHttpResponse} core will bound + serve.
 * Unmatched method/path → 404; disabled module → 404; admin paths on the store surface → 404.
 */
export async function handleRequest(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
): Promise<ModuleHttpResponse> {
  // Feature flag: a disabled module behaves as if it had no endpoints.
  if (!deps.settings.enabled) return json(404, { error: 'not_found' });

  const path = req.path;
  const method = req.method.toUpperCase();
  const isAdmin = req.surface === 'admin';

  // ── ADMIN surface (moderation) — ONLY when the request arrived on the admin mount. ──
  if (isAdmin) {
    if (method === 'GET' && (path === '/queue' || path === '/queue/')) {
      return listQueue(req, deps);
    }
    if (method === 'POST') {
      const mod = moderationFromPath(path);
      if (mod) return moderate(deps, mod.id, mod.action);
    }
    return json(404, { error: 'not_found' });
  }

  // ── STORE surface (public). ──
  // POST /reviews — submit (auth + purchase gated)
  if (method === 'POST' && (path === '/reviews' || path === '/reviews/')) {
    return submitReview(req, deps);
  }
  // GET /reviews?productId= — public approved list + summary
  if (method === 'GET' && (path === '/reviews' || path === '/reviews/')) {
    return listPublic(req, deps);
  }
  // GET /slot?slot=&route= — the slot DATA mount (review-list widget descriptor).
  if (method === 'GET' && (path === '/slot' || path === '/slot/')) {
    return handleReviewsSlot(req, deps.repo);
  }

  return json(404, { error: 'not_found' });
}

/** The verified customer id for this request, or null when the caller is anonymous. */
function requireCustomerId(req: ModuleHttpRequest): string | null {
  const id = req.customer?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function submitReview(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
): Promise<ModuleHttpResponse> {
  // Auth gate: a review is personal-data + purchase-gated, so login is required.
  const customerId = requireCustomerId(req);
  if (!customerId) return json(401, { error: 'login_required' });

  const body = parseBody(req);
  const productId = readId(body?.productId);
  if (!productId) return json(400, { error: 'invalid_product_id' });

  const rating = validateRating(body?.rating);
  if (!rating.ok) return json(400, { error: 'invalid_rating' });

  const text = validateBody(body?.body, deps.settings.minTextLen, deps.settings.maxTextLen);
  if (!text.ok) return json(400, { error: text.error });

  // The product must exist (gated read:products). A failed lookup degrades to "not found" rather
  // than a 500 — you cannot review a product the catalog does not have.
  let productExists: boolean;
  try {
    productExists = (await deps.products.get(productId)) !== null;
  } catch {
    productExists = false;
  }
  if (!productExists) return json(404, { error: 'product_not_found' });

  // PURCHASE GATE: only a customer who bought this product may review it. The verdict
  // comes from the gated read:orders commerce probe (sdk.commerce.hasPurchased) via the seam (B1).
  const purchased = await hasPurchased(deps.commerce, customerId, productId, deps.purchaseVerifier);
  if (!purchased) return json(403, { error: 'not_purchased' });

  const status = deps.settings.autoApprove ? 'approved' : 'pending';
  const row = await deps.repo.create(customerId, productId, rating.rating, text.body, status);
  if (!row) return json(409, { error: 'already_reviewed' });

  return json(201, {
    id: row.id,
    productId: row.product_id,
    rating: row.rating,
    body: row.body,
    status: row.status,
    createdAt: row.created_at,
  });
}

async function listPublic(req: ModuleHttpRequest, deps: HandlerDeps): Promise<ModuleHttpResponse> {
  const productId = readId(firstQuery(req.query.productId));
  if (!productId) return json(400, { error: 'invalid_product_id' });

  // PUBLIC: approved reviews only; the rows AND the { count, average } come from ONE consistent
  // snapshot (a window aggregate) so a concurrent approval can never make them disagree.
  const { reviews, summary } = await deps.repo.approvedWithSummary(productId);
  return json(200, {
    productId,
    reviews,
    average: summary.average,
    count: summary.count,
  });
}

/** Parse a non-negative integer query param (e.g. ?limit / ?offset); undefined when absent/invalid. */
function readUint(value: string | string[] | undefined): number | undefined {
  const first = firstQuery(value);
  if (first === undefined) return undefined;
  const n = Number(first);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

async function listQueue(req: ModuleHttpRequest, deps: HandlerDeps): Promise<ModuleHttpResponse> {
  // Bounded page (the repo clamps limit to [1, MAX_QUEUE_LIMIT]); ?limit / ?offset page the backlog.
  const limit = readUint(req.query.limit);
  const offset = readUint(req.query.offset);
  const rows = await deps.repo.listPending(limit, offset ?? 0);
  // PII: the moderation response intentionally OMITS customer_id — an admin moderates the CONTENT
  // (rating + body), and leaving the reviewer's id out of the queue minimizes the PII surface.
  return json(200, {
    reviews: rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      rating: r.rating,
      body: r.body,
      status: r.status,
      createdAt: r.created_at,
    })),
  });
}

async function moderate(
  deps: HandlerDeps,
  id: string,
  action: 'approve' | 'reject',
): Promise<ModuleHttpResponse> {
  const status = action === 'approve' ? 'approved' : 'rejected';
  const found = await deps.repo.setStatus(id, status);
  return found ? noContent() : json(404, { error: 'not_found' });
}
