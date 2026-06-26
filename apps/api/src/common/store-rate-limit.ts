/**
 * Public storefront per-IP rate limit (— de-duplicated from five store
 * controllers that each hard-coded these values).
 *
 * Env-overridable so a load benchmark can raise the ceiling (`STORE_RATE_LIMIT` set high) without
 * touching any auth/login throttle. Defaults are UNCHANGED (120 requests / 60s). This applies ONLY
 * to the public catalog/search/pages endpoints — never to authentication rate limits.
 */
/** Clamp to ≥1: `|| fallback` already rejects 0/NaN/empty; Math.max rejects negatives (a negative
 * limit would block all traffic, a negative TTL would make the Redis key permanent). */
export const STORE_RATE_LIMIT = Math.max(1, Number(process.env.STORE_RATE_LIMIT) || 120);
export const STORE_RATE_WINDOW_SECONDS = Math.max(
  1,
  Number(process.env.STORE_RATE_WINDOW_SECONDS) || 60,
);
