import { describe, it, expect, vi } from 'vitest';
import { createSovEcomClient, SovEcomApiError, CLIENT_JS_VERSION } from '../src/index.js';
import pkg from '../package.json';

/** A fetch stub that records the call and returns a canned JSON response. */
function stubFetch(
  status: number,
  body: unknown,
): { fetch: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

/** The wrapper sends a case-insensitive `Headers` instance; read it back the same way. */
function headersOf(init: RequestInit): Headers {
  return new Headers(init.headers);
}

describe('@sovecom/client-js', () => {
  it('exposes a version that matches package.json (guards against drift)', () => {
    expect(CLIENT_JS_VERSION).toBe(pkg.version);
  });

  it('strips a trailing slash from baseUrl and fills path params', async () => {
    const { fetch, calls } = stubFetch(201, { orderNumber: 'SO-1001' });
    const client = createSovEcomClient({ baseUrl: 'https://api.test/', fetch });

    const out = await client.checkout<{ orderNumber: string }>('cart-123');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.test/store/v1/carts/cart-123/checkout');
    expect(calls[0]!.init.method).toBe('POST');
    expect(out.orderNumber).toBe('SO-1001');
  });

  it('sends the guest order token in the X-Order-Token header, never the URL', async () => {
    const { fetch, calls } = stubFetch(200, { orderNumber: 'SO-1001' });
    const client = createSovEcomClient({ baseUrl: 'https://api.test', fetch });

    await client.getOrderByNumber('SO-1001', 'secret-token-value');

    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.test/store/v1/orders/by-number/SO-1001');
    expect(url).not.toContain('secret-token-value'); // token must not leak into the URL
    expect(headersOf(init).get('x-order-token')).toBe('secret-token-value');
  });

  it('attaches a bearer token from getToken (sync or async)', async () => {
    const { fetch, calls } = stubFetch(200, []);
    const client = createSovEcomClient({
      baseUrl: 'https://api.test',
      fetch,
      getToken: async () => 'jwt-abc',
    });

    await client.request('get', '/store/v1/orders');

    expect(headersOf(calls[0]!.init).get('authorization')).toBe('Bearer jwt-abc');
  });

  it('omits Authorization when getToken yields nothing', async () => {
    const { fetch, calls } = stubFetch(200, []);
    const client = createSovEcomClient({
      baseUrl: 'https://api.test',
      fetch,
      getToken: () => undefined,
    });

    await client.request('get', '/store/v1/products');

    expect(headersOf(calls[0]!.init).get('authorization')).toBeNull();
  });

  it('does not clobber a caller-supplied Authorization with getToken', async () => {
    const { fetch, calls } = stubFetch(200, {});
    const client = createSovEcomClient({
      baseUrl: 'https://api.test',
      fetch,
      getToken: () => 'jwt-from-token-fn',
    });

    await client.request('get', '/store/v1/orders', {
      headers: { authorization: 'Bearer caller-supplied' },
    } as never);

    expect(headersOf(calls[0]!.init).get('authorization')).toBe('Bearer caller-supplied');
  });

  it('respects a caller content-type (any casing) instead of duplicating it', async () => {
    const { fetch, calls } = stubFetch(200, {});
    const client = createSovEcomClient({ baseUrl: 'https://api.test', fetch });

    await client.request('post', '/store/v1/carts/{cartId}/items', {
      path: { cartId: 'c1' },
      headers: { 'Content-Type': 'application/vnd.custom+json' },
      body: { variantId: 'v1', quantity: 1 },
    } as never);

    // A single, case-insensitively-matched header — the caller's value wins, no second entry.
    expect(headersOf(calls[0]!.init).get('content-type')).toBe('application/vnd.custom+json');
  });

  it('serializes a JSON body and sets Content-Type', async () => {
    const { fetch, calls } = stubFetch(200, { id: 'c1' });
    const client = createSovEcomClient({ baseUrl: 'https://api.test', fetch });

    await client.request('post', '/store/v1/carts/{cartId}/items', {
      path: { cartId: 'c1' },
      body: { variantId: 'v1', quantity: 2 },
    });

    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.test/store/v1/carts/c1/items');
    expect(headersOf(init).get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ variantId: 'v1', quantity: 2 });
  });

  it('builds a query string, skipping null/undefined', async () => {
    const { fetch, calls } = stubFetch(200, { hits: [] });
    const client = createSovEcomClient({ baseUrl: 'https://api.test', fetch });

    await client.request('get', '/store/v1/search', {
      query: { q: 'shoes', page: 2, empty: undefined },
    });

    expect(calls[0]!.url).toBe('https://api.test/store/v1/search?q=shoes&page=2');
  });

  it('throws SovEcomApiError with status + parsed body on non-2xx', async () => {
    const { fetch } = stubFetch(404, { message: 'Order not found' });
    const client = createSovEcomClient({ baseUrl: 'https://api.test', fetch });

    await expect(client.getOrderByNumber('NOPE', 'tok')).rejects.toMatchObject({
      name: 'SovEcomApiError',
      status: 404,
      body: { message: 'Order not found' },
    });
    await expect(client.getOrderByNumber('NOPE', 'tok')).rejects.toBeInstanceOf(SovEcomApiError);
  });

  it('merges default headers and throws on a missing path param', async () => {
    const { fetch, calls } = stubFetch(200, {});
    const client = createSovEcomClient({
      baseUrl: 'https://api.test',
      fetch,
      headers: { 'X-Tenant-Hint': 'default' },
    });

    await client.request('get', '/store/v1/products');
    expect(headersOf(calls[0]!.init).get('x-tenant-hint')).toBe('default');

    // A path template with no value supplied fails fast rather than calling a malformed URL.
    await expect(client.request('get', '/store/v1/orders/{id}', {} as never)).rejects.toThrow(
      /Missing path parameter "id"/,
    );
  });
});
