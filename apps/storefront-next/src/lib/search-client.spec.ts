import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// search-client constructs the client-js client directly (browser-safe — NO next/headers import).
// Mock the package so we capture the options it passes + inject a fake `request`.
const request = vi.fn();
const createSovEcomClient = vi.fn((_opts?: unknown) => ({ request }));
vi.mock('@sovecom/client-js', () => ({
  createSovEcomClient: (opts: unknown) => createSovEcomClient(opts as never),
}));

import { searchInstant } from './search-client';

beforeEach(() => {
  request.mockReset();
  createSovEcomClient.mockClear();
  request.mockResolvedValue({
    hits: [
      {
        id: 'p1',
        slug: 'tee',
        title: 'Tee',
        thumbnailUrl: 'https://cdn/tee.jpg',
        priceAmount: 1999,
        currency: 'EUR',
      },
    ],
    facets: { categories: [], price: null },
    total: 1,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchInstant', () => {
  it('queries /store/v1/search with a small pageSize and maps hits to product cards', async () => {
    const ctrl = new AbortController();
    const res = await searchInstant('tee', ctrl.signal);
    expect(request).toHaveBeenCalledTimes(1);
    const [method, path, opts] = request.mock.calls[0]!;
    expect(method).toBe('get');
    expect(path).toBe('/store/v1/search');
    expect(opts.query.q).toBe('tee');
    expect(opts.query.pageSize).toBeLessThanOrEqual(6);
    expect(res.products).toEqual([
      {
        id: 'p1',
        slug: 'tee',
        title: 'Tee',
        thumbnailUrl: 'https://cdn/tee.jpg',
        priceAmount: 1999,
        currency: 'EUR',
      },
    ]);
    expect(res.total).toBe(1);
  });

  it('threads the AbortSignal through to the request', async () => {
    const ctrl = new AbortController();
    await searchInstant('tee', ctrl.signal);
    const opts = request.mock.calls[0]![2];
    expect(opts.signal).toBe(ctrl.signal);
  });

  it('does NOT swallow an abort error (lets the caller ignore it) but the helper rejects', async () => {
    request.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const ctrl = new AbortController();
    await expect(searchInstant('tee', ctrl.signal)).rejects.toBeTruthy();
  });
});
