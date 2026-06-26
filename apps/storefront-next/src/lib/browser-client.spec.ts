/**
 * browser-client contract.
 *
 * The browser-safe `@sovecom/client-js` factory MUST:
 *   - send `credentials:'include'` on EVERY request (so the httpOnly `sov_cart` + customer refresh
 *     cookies ride along cross-origin storefront→API);
 *   - inject the in-memory customer access token as a Bearer header WHEN present, and omit it when not;
 *   - point at `NEXT_PUBLIC_API_BASE_URL`.
 *
 * We construct the REAL client-js (aliased to source in vitest.config) over a mock `fetch` so we
 * assert on the actual RequestInit client-js builds — not a re-implementation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBrowserClient } from './browser-client';

function mockFetch() {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_API_BASE_URL;
});

describe('createBrowserClient', () => {
  it("sets credentials:'include' on every request", async () => {
    const fetch = mockFetch();
    const client = createBrowserClient({ fetch });
    await client.request('get', '/store/v1/carts/{cartId}', { path: { cartId: 'c1' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe('include');
  });

  it('injects the in-memory access token as a Bearer header when present', async () => {
    const fetch = mockFetch();
    const client = createBrowserClient({ fetch, getAccessToken: () => 'tok-123' });
    await client.request('get', '/store/v1/carts/{cartId}', { path: { cartId: 'c1' } });
    const init = fetch.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer tok-123');
  });

  it('omits the Authorization header when no token is present', async () => {
    const fetch = mockFetch();
    const client = createBrowserClient({ fetch, getAccessToken: () => null });
    await client.request('get', '/store/v1/carts/{cartId}', { path: { cartId: 'c1' } });
    const init = fetch.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.has('authorization')).toBe(false);
  });

  it('omits Authorization when no getAccessToken seam is provided at all', async () => {
    const fetch = mockFetch();
    const client = createBrowserClient({ fetch });
    await client.request('get', '/store/v1/carts/{cartId}', { path: { cartId: 'c1' } });
    const init = fetch.mock.calls[0]![1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.has('authorization')).toBe(false);
  });

  it('reads a fresh token on each request (live getter, not a snapshot)', async () => {
    const fetch = mockFetch();
    let token: string | null = null;
    const client = createBrowserClient({ fetch, getAccessToken: () => token });
    await client.request('get', '/store/v1/carts/{cartId}', { path: { cartId: 'c1' } });
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).has('authorization')).toBe(false);
    token = 'later-tok';
    await client.request('get', '/store/v1/carts/{cartId}', { path: { cartId: 'c1' } });
    expect(new Headers(fetch.mock.calls[1]![1]!.headers).get('authorization')).toBe(
      'Bearer later-tok',
    );
  });

  it('targets NEXT_PUBLIC_API_BASE_URL', async () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com';
    const fetch = mockFetch();
    const client = createBrowserClient({ fetch });
    await client.request('get', '/store/v1/carts/{cartId}', { path: { cartId: 'c1' } });
    const url = fetch.mock.calls[0]![0] as string;
    expect(url).toBe('https://api.example.com/store/v1/carts/c1');
  });
});
