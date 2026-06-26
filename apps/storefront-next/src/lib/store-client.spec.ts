import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// next/headers `cookies()` is only available inside the Next request scope; mock it for unit tests.
const cookieGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: cookieGet }),
}));

import {
  getApiBaseUrl,
  createStoreClient,
  getCartCookieHeader,
  createStoreClientWithCart,
  CART_COOKIE,
} from './store-client';

const ORIGINAL_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;

afterEach(() => {
  if (ORIGINAL_BASE === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
  else process.env.NEXT_PUBLIC_API_BASE_URL = ORIGINAL_BASE;
  vi.restoreAllMocks();
  cookieGet.mockReset();
});

describe('getApiBaseUrl', () => {
  it('uses NEXT_PUBLIC_API_BASE_URL when set', () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com';
    expect(getApiBaseUrl()).toBe('https://api.example.com');
  });

  it('falls back to localhost when unset', () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    expect(getApiBaseUrl()).toBe('http://localhost:3000');
  });
});

describe('createStoreClient', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com';
  });

  it('constructs a client that requests against the configured base URL (smoke, mocked fetch)', async () => {
    const fetchMock: typeof fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ name: 't', version: '1', settings: {} }), { status: 200 }),
    );
    const client = createStoreClient({ fetch: fetchMock });
    await client.request('get', '/store/v1/theme');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchMock).mock.calls[0]![0]).toBe('https://api.example.com/store/v1/theme');
  });
});

describe('getCartCookieHeader', () => {
  it('returns a Cookie header forwarding sov_cart when present', async () => {
    cookieGet.mockReturnValue({ value: 'abc123' });
    expect(await getCartCookieHeader()).toBe(`${CART_COOKIE}=abc123`);
    expect(cookieGet).toHaveBeenCalledWith(CART_COOKIE);
  });

  it('returns undefined when no cart cookie exists', async () => {
    cookieGet.mockReturnValue(undefined);
    expect(await getCartCookieHeader()).toBeUndefined();
  });
});

describe('createStoreClientWithCart', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com';
  });

  it('forwards the sov_cart cookie as a default header on the constructed client', async () => {
    cookieGet.mockReturnValue({ value: 'cart-token' });
    const fetchMock: typeof fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = await createStoreClientWithCart();
    await client.request('get', '/store/v1/theme');

    expect(cookieGet).toHaveBeenCalledWith(CART_COOKIE);
    const init = vi.mocked(fetchMock).mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(headers.get('cookie')).toBe(`${CART_COOKIE}=cart-token`);
  });

  it('sends no cookie header when no cart cookie exists', async () => {
    cookieGet.mockReturnValue(undefined);
    const fetchMock: typeof fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = await createStoreClientWithCart();
    await client.request('get', '/store/v1/theme');

    const init = vi.mocked(fetchMock).mock.calls[0]![1]!;
    expect(new Headers(init.headers).get('cookie')).toBeNull();
  });
});
