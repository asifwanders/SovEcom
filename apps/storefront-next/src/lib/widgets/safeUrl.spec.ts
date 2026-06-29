/**
 * safeImageUrl / mediaOrigin contract.
 *
 * Security guarantees:
 *   - `javascript:`, `data:`, `//protocol-relative` and other non-http(s) schemes are dropped.
 *   - An absolute http(s) URL to an ARBITRARY third-party host is dropped (PII egress guard).
 *   - A URL whose origin matches the configured API/media base IS allowed.
 *   - A root-relative path (same-origin, not protocol-relative) is allowed.
 *
 * Server-side fix (FIX 3):
 *   When window is undefined (RSC / server context), `mediaOrigin()` must resolve from
 *   `process.env.API_BASE_URL` (set in the storefront container) rather than falling back only to
 *   `NEXT_PUBLIC_API_BASE_URL` (which is NOT set in the compose deployment). Without this fix,
 *   `mediaOrigin()` returned null and every stored absolute image URL was silently dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { safeImageUrl } from './safeUrl';

// ── helpers ────────────────────────────────────────────────────────────────────

/** Temporarily delete window to simulate a server (RSC) execution context in jsdom. */
function withoutWindow(fn: () => void) {
  const w = global.window;
  // @ts-expect-error — intentionally removing window to simulate server
  delete global.window;
  try {
    fn();
  } finally {
    global.window = w;
  }
}

// ── scheme guard ───────────────────────────────────────────────────────────────

describe('safeImageUrl — scheme guard', () => {
  it('drops javascript: URLs', () => {
    expect(safeImageUrl('javascript:alert(1)')).toBeUndefined();
  });

  it('drops data: URLs', () => {
    expect(safeImageUrl('data:image/png;base64,abc')).toBeUndefined();
  });

  it('drops protocol-relative URLs (//host)', () => {
    expect(safeImageUrl('//evil.com/img.png')).toBeUndefined();
  });

  it('drops ftp: URLs', () => {
    expect(safeImageUrl('ftp://files.example.com/img.png')).toBeUndefined();
  });

  it('allows root-relative paths', () => {
    expect(safeImageUrl('/uploads/img.png')).toBe('/uploads/img.png');
  });

  it('drops empty string', () => {
    expect(safeImageUrl('')).toBeUndefined();
  });

  it('drops non-string', () => {
    expect(safeImageUrl(42)).toBeUndefined();
    expect(safeImageUrl(null)).toBeUndefined();
  });
});

// ── host allowlist guard (client context, NEXT_PUBLIC_API_BASE_URL) ────────────

describe('safeImageUrl — host allowlist (client context)', () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com';
    // Ensure window is defined (jsdom default) and __SOVECOM__ is absent so the
    // apiBaseUrl() fallback path reads NEXT_PUBLIC_API_BASE_URL.
    if (typeof window !== 'undefined') {
      window.__SOVECOM__ = undefined;
    }
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('allows an absolute URL whose origin matches the configured API base', () => {
    const url = 'https://api.example.com/uploads/hero.png';
    expect(safeImageUrl(url)).toBe(url);
  });

  it('drops an absolute URL to a different host', () => {
    expect(safeImageUrl('https://evil.com/phish.png')).toBeUndefined();
  });

  it('drops an absolute URL to a subdomain of the configured origin', () => {
    expect(safeImageUrl('https://cdn.api.example.com/img.png')).toBeUndefined();
  });
});

// ── server-side resolution (FIX 3) ────────────────────────────────────────────

describe('safeImageUrl — server-side resolution (API_BASE_URL, window === undefined)', () => {
  const OLD_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('allows an API-origin URL when only API_BASE_URL is set (compose deployment)', () => {
    process.env.API_BASE_URL = 'https://api.65-21-159-53.nip.io';
    delete process.env.NEXT_PUBLIC_API_BASE_URL;

    let result: string | undefined;
    withoutWindow(() => {
      // Re-require so the module sees the updated env (vitest caches modules; vi.resetModules
      // not needed here because resolveMediaBase() reads process.env at call time — not module load).
      result = safeImageUrl('https://api.65-21-159-53.nip.io/uploads/hero.png');
    });

    expect(result).toBe('https://api.65-21-159-53.nip.io/uploads/hero.png');
  });

  it('drops a third-party URL even when API_BASE_URL is set', () => {
    process.env.API_BASE_URL = 'https://api.65-21-159-53.nip.io';
    delete process.env.NEXT_PUBLIC_API_BASE_URL;

    let result: string | undefined;
    withoutWindow(() => {
      result = safeImageUrl('https://evil.com/phish.png');
    });

    expect(result).toBeUndefined();
  });

  it('falls back to NEXT_PUBLIC_API_BASE_URL on the server when API_BASE_URL is absent', () => {
    delete process.env.API_BASE_URL;
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com';

    let result: string | undefined;
    withoutWindow(() => {
      result = safeImageUrl('https://api.example.com/uploads/img.png');
    });

    expect(result).toBe('https://api.example.com/uploads/img.png');
  });

  it('returns undefined (drops all absolute URLs) when neither env var is set on the server', () => {
    delete process.env.API_BASE_URL;
    delete process.env.NEXT_PUBLIC_API_BASE_URL;

    let result: string | undefined;
    withoutWindow(() => {
      result = safeImageUrl('https://api.example.com/uploads/img.png');
    });

    expect(result).toBeUndefined();
  });

  it('still allows root-relative paths on the server regardless of env config', () => {
    delete process.env.API_BASE_URL;
    delete process.env.NEXT_PUBLIC_API_BASE_URL;

    let result: string | undefined;
    withoutWindow(() => {
      result = safeImageUrl('/uploads/img.png');
    });

    expect(result).toBe('/uploads/img.png');
  });
});
