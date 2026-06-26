/**
 * notify-back-in-stock — the HTTP handlers behind `sdk.serve`.
 *
 * Routes (mounted by core under `/store/v1/modules/notify-back-in-stock/*`):
 *   POST   /subscriptions          body { variantId, email }  → subscribe to a restock notification
 *   DELETE /subscriptions/:variantId   body { email }         → unsubscribe (optional convenience)
 *
 * GUEST-FRIENDLY: subscribe does NOT require login — the subscriber supplies their
 * OWN email. The subscription is therefore EMAIL-keyed, not customer-keyed. When `req.customer` IS
 * present (the core-verified principal from the 3.10-i.5 bridge) its id is recorded alongside, but
 * it is never the key and never trusted from the body.
 *
 * EMAIL IS UNTRUSTED INPUT: it is validated with the SAME header-injection-safe rule the email port
 * uses (single, syntactically-valid address; no CR/LF/comma/semicolon; bounded length) BEFORE it is
 * stored, so a malformed/abusive address is a 400 at the boundary rather than a stored row that only
 * fails later at send. (Abuse note: a guest could subscribe someone else's address — standard for an
 * email-keyed restock notify; the blast radius is one transactional "back in stock" email, and the
 * core port rate-limits + audits every send. A double-opt-in confirmation is a future enhancement.)
 *
 * The handlers are pure over an injected repository + settings, so they unit-test against a mocked
 * SDK.
 */
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';
import type { NotifyRepository } from '../db/repository';
import type { NotifySettings } from '../settings';
import { validateEmail } from './email-validation';
import { handleNotifySlot } from '../slot/notify-slot';

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
 * caller could POST `/subscriptions/%2Fetc%2Fpasswd` → after decodeURIComponent the id would contain a
 * slash; SQL is parameterized so it is harmless TODAY, but a decoded id smuggling a separator/control
 * byte is never a legitimate variant id — reject it at the boundary. Hex escapes only.
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

/** Extract the trailing `:id` segment from a `/subscriptions/<id>` path. */
function variantIdFromPath(path: string): string | undefined {
  const m = /^\/subscriptions\/([^/]+)\/?$/.exec(path);
  if (!m) return undefined;
  // A malformed percent-escape (e.g. `/subscriptions/%zz`) makes decodeURIComponent throw URIError.
  // Treat it as a non-match (→ 404) rather than letting it bubble to an unhandled 500.
  let decoded: string;
  try {
    decoded = decodeURIComponent(m[1]!);
  } catch {
    return undefined;
  }
  return readId(decoded);
}

export interface HandlerDeps {
  readonly repo: NotifyRepository;
  readonly settings: NotifySettings;
}

/**
 * Handle one mounted request. Returns the {@link ModuleHttpResponse} core will bound + serve.
 * Unmatched method/path → 404; disabled module → 404.
 */
export async function handleRequest(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
): Promise<ModuleHttpResponse> {
  // Feature flag: a disabled module behaves as if it had no endpoints.
  if (!deps.settings.enabled) return json(404, { error: 'not_found' });

  const path = req.path;
  const method = req.method.toUpperCase();

  // POST /subscriptions — subscribe (body { variantId, email })
  if (method === 'POST' && (path === '/subscriptions' || path === '/subscriptions/')) {
    return subscribe(req, deps);
  }
  // POST /subscriptions/:variantId — bodyless subscribe endpoint where the variant id rides in the
  // path (the form posts only its declared `email` field).
  if (method === 'POST') {
    const variantId = variantIdFromPath(path);
    if (variantId) return subscribeByPath(req, deps, variantId);
  }
  // GET /slot?slot=&route= — the slot DATA mount (submit-form widget descriptor).
  if (method === 'GET' && (path === '/slot' || path === '/slot/')) {
    return handleNotifySlot(req);
  }
  // DELETE /subscriptions/:variantId — unsubscribe
  if (method === 'DELETE') {
    const variantId = variantIdFromPath(path);
    if (variantId) return unsubscribe(req, deps, variantId);
  }

  return json(404, { error: 'not_found' });
}

/** The verified customer id for this request, or null when the caller is anonymous (guest). */
function customerIdOrNull(req: ModuleHttpRequest): string | null {
  const id = req.customer?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

async function subscribe(req: ModuleHttpRequest, deps: HandlerDeps): Promise<ModuleHttpResponse> {
  const body = parseBody(req);

  const productVariantId = readId(body?.variantId);
  if (!productVariantId) {
    return json(400, { error: 'invalid_variant_id' });
  }

  const email = validateEmail(body?.email);
  if (!email) {
    return json(400, { error: 'invalid_email' });
  }

  // Guest-friendly: login is NOT required. Record the verified customer id when present (never the
  // key, never from the body).
  const customerId = customerIdOrNull(req);

  await deps.repo.subscribe(email, productVariantId, customerId);
  return json(201, { variantId: productVariantId, email });
}

/**
 * Path-based subscribe `POST /subscriptions/:variantId` — the variant id comes from the PATH (the
 * submit-form slot widget posts only its declared `email` field, no `variantId` in the body). Email is
 * still UNTRUSTED input, validated identically to the body-keyed `subscribe`. Guest-friendly (login not
 * required); a verified `req.customer.id` is recorded when present but is never the key.
 */
async function subscribeByPath(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
  productVariantId: string,
): Promise<ModuleHttpResponse> {
  const body = parseBody(req);
  const email = validateEmail(body?.email);
  if (!email) {
    return json(400, { error: 'invalid_email' });
  }
  const customerId = customerIdOrNull(req);
  await deps.repo.subscribe(email, productVariantId, customerId);
  return json(201, { variantId: productVariantId, email });
}

async function unsubscribe(
  req: ModuleHttpRequest,
  deps: HandlerDeps,
  productVariantId: string,
): Promise<ModuleHttpResponse> {
  const body = parseBody(req);
  const email = validateEmail(body?.email);
  if (!email) {
    return json(400, { error: 'invalid_email' });
  }

  const removed = await deps.repo.unsubscribe(email, productVariantId);
  return removed ? noContent() : json(404, { error: 'not_found' });
}
