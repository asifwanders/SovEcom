import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSlotWidget, WIDGET_FETCH_MAX_BYTES } from './fetchSlotWidget';

/**
 * C2 server-side widget fetch. Mirrors `lib/theme.ts`'s fetchActiveTheme: cache()-wrapped,
 * timeout-bounded, null-on-any-failure. This is the READ-ONLY server path — route-keyed, carries
 * NO customer credentials (cacheable). It re-validates the body through C1's parseWidget. It must
 * NEVER throw and NEVER be used for a personalized widget.
 */

const VALID: unknown = {
  type: 'star-rating-summary',
  props: { average: 4.5, count: 12 },
};

function stubFetch(impl: typeof fetch): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => vi.restoreAllMocks());

describe('fetchSlotWidget', () => {
  it('returns the typed descriptor on a valid 200 JSON body', async () => {
    stubFetch(async () => new Response(JSON.stringify(VALID), { status: 200 }));
    const result = await fetchSlotWidget('reviews', 'product-detail-reviews-section', '/product/tee');
    expect(result).toEqual(VALID);
  });

  it('returns null on a 204 (module declines to render)', async () => {
    stubFetch(async () => new Response(null, { status: 204 }));
    expect(await fetchSlotWidget('reviews', 'product-card-actions', '/')).toBeNull();
  });

  it('returns null on a non-200 status (404 / 500)', async () => {
    for (const status of [404, 500, 403, 429]) {
      stubFetch(async () => new Response(JSON.stringify(VALID), { status }));
      expect(await fetchSlotWidget('m', 's', '/')).toBeNull();
    }
  });

  it('returns null on a transport error (never throws)', async () => {
    stubFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fetchSlotWidget('m', 's', '/')).resolves.toBeNull();
  });

  it('returns null on an over-cap Content-Length and CANCELS the body (volume bound, no buffering)', async () => {
    // A declared Content-Length over the cap must short-circuit to null and CANCEL the body — the body
    // is never fully read/buffered (an OOM would 500 the page for everyone). The load-bearing assertion
    // is that the body was cancelled (connection released) without the read loop running.
    let bytesRead = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = new TextEncoder().encode('x'.repeat(1024));
        bytesRead += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    stubFetch(
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-length': String(WIDGET_FETCH_MAX_BYTES + 1) },
        }),
    );
    expect(await fetchSlotWidget('m', 's', '/')).toBeNull();
    expect(cancelled).toBe(true); // released the connection
    // The body was NOT drained — at most an eager single-chunk pull, never the whole over-cap body.
    expect(bytesRead).toBeLessThanOrEqual(WIDGET_FETCH_MAX_BYTES);
  });

  it('returns null on a STREAMED over-cap body (no Content-Length) — aborts mid-stream, never buffers all', async () => {
    // No Content-Length, but the stream keeps producing > cap. The reader must bail the MOMENT the
    // running count exceeds the cap (abort + cancel), NOT after buffering the whole gigabyte body.
    const CHUNK = 16 * 1024;
    let produced = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += CHUNK;
        controller.enqueue(new TextEncoder().encode('y'.repeat(CHUNK)));
      },
      cancel() {
        cancelled = true;
      },
    });
    stubFetch(async () => new Response(body, { status: 200 }));
    expect(await fetchSlotWidget('m', 's', '/')).toBeNull();
    expect(cancelled).toBe(true);
    // It stopped soon after crossing the cap — NOT an unbounded read. Allow a few chunks of slack.
    expect(produced).toBeLessThanOrEqual(WIDGET_FETCH_MAX_BYTES + CHUNK * 2);
  });

  it('returns null on an over-cap body materialized by text() (no-stream fallback path)', async () => {
    const huge = 'x'.repeat(WIDGET_FETCH_MAX_BYTES + 10);
    stubFetch(async () => new Response(JSON.stringify({ type: 'review-list', props: { items: [], pad: huge } }), { status: 200 }));
    expect(await fetchSlotWidget('m', 's', '/')).toBeNull();
  });

  it('returns null on an invalid descriptor (unknown type / bad props)', async () => {
    for (const bad of [
      { type: 'evil-widget', props: {} },
      { type: 'star-rating-summary', props: { average: 99, count: -1 } },
      { type: 'star-rating-summary' },
      'not json at all {',
      JSON.stringify([1, 2, 3]),
      JSON.stringify(null),
    ]) {
      stubFetch(async () =>
        new Response(typeof bad === 'string' ? bad : JSON.stringify(bad), { status: 200 }),
      );
      expect(await fetchSlotWidget('m', 's', '/')).toBeNull();
    }
  });

  it('sends NO credentials and NO cookie (cacheable, route-keyed server read)', async () => {
    const spy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(VALID), { status: 200 }));
    stubFetch(spy);
    await fetchSlotWidget('reviews', 'product-card-actions', '/product/tee');
    const [, init] = spy.mock.calls[0]!;
    // No credentials forwarded; no cookie / Authorization header attached.
    expect((init as RequestInit | undefined)?.credentials).not.toBe('include');
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('authorization')).toBe(false);
  });

  it('targets the module mount with slot + route as query params', async () => {
    const spy = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(VALID), { status: 200 }));
    stubFetch(spy);
    await fetchSlotWidget('reviews', 'product-detail-reviews-section', '/product/tee');
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/store/v1/modules/reviews/slot');
    expect(url).toContain('slot=product-detail-reviews-section');
    expect(url).toContain(`route=${encodeURIComponent('/product/tee')}`);
  });

  it('returns null when the abort signal fires (timeout) — never throws', async () => {
    stubFetch((_input, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    // Force an immediate abort by passing a timeout of 0.
    await expect(
      fetchSlotWidget('m', 's', '/', { timeoutMs: 0 }),
    ).resolves.toBeNull();
  });
});
