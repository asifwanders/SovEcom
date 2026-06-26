/**
 * Image-URL guard against scheme injection and PII egress.
 *
 * A module-supplied `imageUrl` reaches the DOM as an `<img src>`. Two threats are gated here:
 *   1. SCHEME — only `http(s)` may render (a `javascript:`/`data:`/protocol-relative/other-scheme
 *      URL is dropped → no `<img>`).
 *   2. HOST (PII egress) — a module `<img src>` to an ARBITRARY third-party host would leak EVERY
 *      visitor's IP/User-Agent to that host on load. So an absolute URL is allowed ONLY when its
 *      origin is the storefront's configured API/media base (`NEXT_PUBLIC_API_BASE_URL`) — the one
 *      already-approved origin assets are served from. A root-relative path (same-origin) is also
 *      allowed. Anything off-allowlist is dropped.
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
 * The configured API/media base ORIGIN (e.g. `https://api.example.com`), or null if unparseable. Uses
 * the ISOMORPHIC `apiBaseUrl()` (reads `NEXT_PUBLIC_API_BASE_URL`) — NOT the server-only `store-client`
 * `getApiBaseUrl` — because this guard is reached from BOTH the read-only RSC carousel AND the client
 * island (via the registry), so it must not pull `next/headers` into the client bundle.
 */
function mediaOrigin(): string | null {
  try {
    return new URL(apiBaseUrl()).origin;
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
