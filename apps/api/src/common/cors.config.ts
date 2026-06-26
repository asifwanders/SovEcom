/**
 * CORS allowlist builder.
 *
 * Extracted from `main.ts` as a PURE helper so the credentialed cross-origin contract can be
 * unit-tested without booting Nest. The API is consumed cross-origin by TWO credentialed clients:
 * - the admin SPA (`ADMIN_ORIGIN`, comma-separated) — refresh cookie;
 *   - the storefront (`STORE_ORIGIN`, comma-separated) — the SAME env already used by the customer
 *     refresh-CSRF allowlist (`customer-refresh.guard.ts`), reused here so the two surfaces can never
 *     drift. Adding the storefront origin is what unblocks the credentialed `sov_cart` + customer
 * refresh cookies riding along storefront→API (: previously blocked).
 *
 * Both origins are merged into ONE explicit allowlist. `credentials:true` REQUIRES an explicit list
 * (never `*`) — when neither env is set (dev), CORS is fail-closed (`origin:false`). `allowedHeaders`
 * gains `X-Order-Token` (the guest-order lookup header) on top of the existing
 * `Content-Type` + `Authorization`.
 */

/** The CORS shape consumed by `app.enableCors(...)` (a subset of Nest's `CorsOptions`). */
export interface CorsConfig {
  /** Explicit origin allowlist, or `false` to fail closed (no cross-origin allowed). */
  origin: string[] | false;
  credentials: true;
  methods: string[];
  allowedHeaders: string[];
}

/** Parse a comma-separated origin env into a trimmed, non-empty list. */
function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Build the credentialed CORS config from the admin + store origin envs. De-duplicates so an origin
 * listed in both envs appears once. Fail-closed (`origin:false`) when neither env yields an origin.
 */
export function buildCorsConfig(env: { ADMIN_ORIGIN?: string; STORE_ORIGIN?: string }): CorsConfig {
  const merged = [...parseOrigins(env.ADMIN_ORIGIN), ...parseOrigins(env.STORE_ORIGIN)];
  const allowlist = Array.from(new Set(merged));
  return {
    origin: allowlist.length > 0 ? allowlist : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // `X-Order-Token` carries the guest-order lookup token cross-origin (never in the URL).
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Order-Token'],
  };
}
