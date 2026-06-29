/**
 * Image-URL guard against scheme injection and PII egress.
 *
 * A module-supplied `imageUrl` reaches the DOM as an `<img src>`. Two threats are gated here:
 *   1. SCHEME — only `http(s)` may render (a `javascript:`/`data:`/protocol-relative/other-scheme
 *      URL is dropped → no `<img>`).
 *   2. HOST (PII egress) — a module `<img src>` to an ARBITRARY third-party host would leak EVERY
 *      visitor's IP/User-Agent to that host on load. So an absolute URL is allowed ONLY when its
 *      origin is the storefront's configured API/media base — the one already-approved origin assets
 *      are served from. A root-relative path (same-origin) is also allowed. Anything off-allowlist
 *      is dropped.
 *
 * The storefront has no next/image `remotePatterns` allowlist to reuse (`images.unoptimized`), and
 * catalog thumbnails are TRUSTED tenant URLs — but module data is UNTRUSTED, so it gets the stricter
 * origin gate. Mirrors `themeLogoUrl`'s scheme posture, plus the host allowlist.
 *
 * Future enhancement: v1 restricts module images to same-origin / the configured media base. A
 * broader admin-configurable image-host allowlist (per-tenant, multiple CDNs) may be added in the
 * future as an additive enhancement (swap the single-origin check for an allowlist lookup).
 */
import { apiBaseUrl } from '@/lib/browser-client';

/**
 * Resolve the raw API/media base URL string for the current execution context.
 *
 * Resolution order (mirrors store-client.ts server logic + browser-client.ts client logic):
 *   SERVER (window === undefined):
 *     1. process.env.API_BASE_URL  — set in the storefront container; works without a build-arg.
 *     2. process.env.NEXT_PUBLIC_API_BASE_URL — build-time fallback / `next dev`.
 *   CLIENT (window is defined):
 *     delegates to `apiBaseUrl()` which reads window.__SOVECOM__.apiBaseUrl → NEXT_PUBLIC_API_BASE_URL.
 *
 * We avoid importing `getApiBaseUrl` from `store-client` because that module imports `next/headers`
 * (a server-only module). Calling `apiBaseUrl()` on the server is safe — it just falls through to
 * `process.env.NEXT_PUBLIC_API_BASE_URL` when window is undefined — but in the compose deployment
 * NEXT_PUBLIC_API_BASE_URL is NOT set, so we must check API_BASE_URL first on the server side.
 */
function resolveMediaBase(): string {
  if (typeof window === 'undefined') {
    // Server context: prefer the runtime-injected env var (set in docker-compose storefront service).
    return process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || '';
  }
  // Client context: use the isomorphic resolver (window.__SOVECOM__ → NEXT_PUBLIC_API_BASE_URL).
  return apiBaseUrl();
}

/**
 * The configured API/media base ORIGIN (e.g. `https://api.example.com`), or null if unparseable.
 * On the server this reads API_BASE_URL (the env var set in the storefront container).
 * On the client this reads window.__SOVECOM__.apiBaseUrl / NEXT_PUBLIC_API_BASE_URL.
 */
function mediaOrigin(): string | null {
  try {
    const base = resolveMediaBase();
    if (!base) return null;
    return new URL(base).origin;
  } catch {
    return null;
  }
}

export function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return undefined;

  // Same-origin root-relative path (`/uploads/x.png`) — allowed (NOT protocol-relative `//host`).
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;

  // Absolute URL — must be http(s) AND its origin must be the configured media/API base (PII-egress
  // guard). Any other host (or scheme) is dropped.
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    const allowed = mediaOrigin();
    if (allowed && u.origin === allowed) return trimmed;
    return undefined;
  } catch {
    return undefined;
  }
}
