/**
 * CORS allowlist contract.
 *
 * Pins the credentialed cross-origin contract the storefront cart/checkout depends on: the storefront
 * origin (`STORE_ORIGIN`) is allowed WITH credentials, `X-Order-Token` is an allowed header, the admin
 * origin is still honoured, and a disallowed origin is rejected (fail-closed when no env is set).
 */
import { buildCorsConfig } from './cors.config';

describe('buildCorsConfig', () => {
  it('allows the storefront origin (STORE_ORIGIN) with credentials', () => {
    const cfg = buildCorsConfig({ STORE_ORIGIN: 'https://shop.example.com' });
    expect(cfg.credentials).toBe(true);
    expect(cfg.origin).toContain('https://shop.example.com');
  });

  it('still honours the admin origin and merges both envs', () => {
    const cfg = buildCorsConfig({
      ADMIN_ORIGIN: 'https://admin.example.com',
      STORE_ORIGIN: 'https://shop.example.com',
    });
    expect(cfg.origin).toEqual(
      expect.arrayContaining(['https://admin.example.com', 'https://shop.example.com']),
    );
  });

  it('parses comma-separated origins and trims whitespace', () => {
    const cfg = buildCorsConfig({ STORE_ORIGIN: 'https://a.example.com, https://b.example.com' });
    expect(cfg.origin).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('de-duplicates an origin listed in both envs', () => {
    const cfg = buildCorsConfig({
      ADMIN_ORIGIN: 'https://same.example.com',
      STORE_ORIGIN: 'https://same.example.com',
    });
    expect(cfg.origin).toEqual(['https://same.example.com']);
  });

  it('includes X-Order-Token (plus Content-Type + Authorization) in allowedHeaders', () => {
    const cfg = buildCorsConfig({ STORE_ORIGIN: 'https://shop.example.com' });
    expect(cfg.allowedHeaders).toEqual(
      expect.arrayContaining(['Content-Type', 'Authorization', 'X-Order-Token']),
    );
  });

  it('fails closed (origin:false) when neither env is set — a disallowed origin is rejected', () => {
    const cfg = buildCorsConfig({});
    expect(cfg.origin).toBe(false);
  });

  it('does NOT allow an arbitrary disallowed origin', () => {
    const cfg = buildCorsConfig({ STORE_ORIGIN: 'https://shop.example.com' });
    // The allowlist is explicit; an evil origin is simply absent from it.
    expect(cfg.origin).not.toContain('https://evil.example.com');
  });

  it('preserves the full method list including OPTIONS (preflight)', () => {
    const cfg = buildCorsConfig({ STORE_ORIGIN: 'https://shop.example.com' });
    expect(cfg.methods).toEqual(
      expect.arrayContaining(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
    );
  });
});
