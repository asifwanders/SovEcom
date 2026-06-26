/**
 * the module HTTP endpoint contract types, EXTRACTED here as
 * the single source of truth (was `apps/api/src/modules/runtime/module-http.ts`). These are the
 * wire shapes an author's `sdk.serve(handler)` deals with; core shapes the request and BOUNDS
 * the response. The byte caps / header allowlists / media-type policy stay core-side (they are
 * enforcement, not contract) and are intentionally NOT exported from the public SDK.
 */

/** Which mounted surface the request arrived on. `store` is public; `admin` is RBAC-gated. */
export type ModuleHttpSurface = 'store' | 'admin';

export interface ModuleHttpRequest {
  readonly surface: ModuleHttpSurface;
  readonly method: string;
  /** The path UNDER the module mount, e.g. `/items/42` for `/store/v1/modules/foo/items/42`. */
  readonly path: string;
  readonly query: Record<string, string | string[]>;
  /** Already-sanitized request headers (core strips hop-by-hop + auth/cookie). */
  readonly headers: Record<string, string>;
  readonly body?: string;
  /** The tenant the request is scoped to (the module cannot widen it). */
  readonly tenantId: string;
  /**
   * The CORE-VERIFIED customer principal for this request, or `undefined` for an anonymous call.
   *
   * Set ONLY by the core proxy from a customer JWT it verified itself (the store mount runs an
   * optional customer-auth guard). It is NEVER read from client input — a `customer` field in the
   * request body, headers, or query cannot influence it, and the raw token is still stripped before
   * the request reaches the module. Absent (`undefined`) when no valid customer token was presented.
   *
   * The `id` is the same tenant-scoped customer id the JWT verification resolved against the DB;
   * a customer-scoped module endpoint should return 401/empty when this is absent.
   */
  readonly customer?: { readonly id: string };
}

export interface ModuleHttpResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** A module's request handler, registered via `sdk.serve(...)`. */
export type ModuleHttpHandler = (
  req: ModuleHttpRequest,
) => ModuleHttpResponse | Promise<ModuleHttpResponse>;
