/**
 * the module HTTP endpoint contract.
 *
 * Core mounts `/{store,admin}/v1/modules/:name/*` and proxies each request to the module worker
 * over a broker `http.handle` RPC; the worker's SDK-registered handler returns a response. These
 * are the wire shapes for that round-trip. Core shapes the request (the module never sees raw
 * core internals) and BOUNDS the response (status clamp, header allowlist, body cap) — a module's
 * response is untrusted.
 */

// the module HTTP CONTRACT types (surface / request / response /
// handler) were EXTRACTED into `@sovecom/module-sdk` (single source of truth). Re-exported here
// so the in-tree runtime importers keep their `./module-http` path. The core-side ENFORCEMENT
// constants below (byte caps, header allowlist, safe media types) are NOT part of the public SDK.
export type {
  ModuleHttpSurface,
  ModuleHttpRequest,
  ModuleHttpResponse,
  ModuleHttpHandler,
} from '@sovecom/module-sdk';

/** The RPC method core → worker uses to deliver a mounted request. */
export const MODULE_HTTP_METHOD = 'http.handle';

/**
 * Caps applied core-side to a proxied request/response. Kept BELOW the IPC frame cap
 * (MAX_FRAME_BYTES, 1 MiB) so the body limit is enforced cleanly here (a 502 / dropped body)
 * rather than as a dropped IPC frame that would surface only as an RPC timeout.
 */
export const MAX_MODULE_RESPONSE_BYTES = 512 * 1024; // 512 KiB
export const MAX_MODULE_REQUEST_BODY_BYTES = 512 * 1024; // 512 KiB

/**
 * Response headers a module MAY set on a proxied response. Everything else (set-cookie, auth,
 * security headers, transfer/encoding) is dropped — a module cannot inject cookies, override the
 * store/admin security headers, or smuggle a redirect-auth.
 */
export const ALLOWED_MODULE_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-language',
  'cache-control',
]);

/**
 * The ONLY media types a module response may declare. A module response is served on the API
 * origin (the store surface is public), so active types — `text/html`, `image/svg+xml`, etc. —
 * are NOT allowed (they would let module bytes render as HTML/JS / phish on a trusted origin).
 * Anything else (or omitted) is coerced to `application/octet-stream` so it downloads, not renders.
 */
export const SAFE_RESPONSE_MEDIA_TYPES = new Set([
  'application/json',
  'text/plain',
  'text/csv',
  'application/octet-stream',
]);
export const DEFAULT_RESPONSE_MEDIA_TYPE = 'application/octet-stream';
