/**
 * reviews — slot data-RPC handler tests (mocked SDK).
 *
 * The `GET /slot?slot=product-detail-reviews-section&route=<productId>` mount returns a `review-list`
 * widget descriptor (`{ type, props }`) the storefront renders — data only. These tests drive the
 * handleRequest and repository against in-memory FakeTables, asserting:
 *   - a valid product route → a `review-list` descriptor of the approved reviews
 *     (id/rating/body/createdAt; no author/customer id — public read is anonymous);
 *   - pending/rejected reviews are excluded;
 *   - an unknown slot or missing route → 204 (the module declines to render);
 *   - the descriptor is bounded (≤50 items, body ≤2000 chars).
 */
import { describe, it, expect } from 'vitest';
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { ReviewsRepository } from '../src/db/repository';
import { resolveSettings, type ReviewsSettings } from '../src/settings';
import { REVIEW_LIST_MAX_ITEMS, REVIEW_BODY_MAX_LEN } from '../src/slot/reviews-slot';
import { FakeTables, FakeCommerce, FakeStore } from './_mock-sdk';

function makeDeps(settings?: Partial<ReviewsSettings>): { deps: HandlerDeps; tables: FakeTables } {
  const tables = new FakeTables();
  const deps: HandlerDeps = {
    repo: new ReviewsRepository(tables),
    products: new FakeStore().products,
    commerce: new FakeCommerce(() => true),
    settings: resolveSettings(settings),
  };
  return { deps, tables };
}

function slotReq(partial: Partial<ModuleHttpRequest> = {}): ModuleHttpRequest {
  return {
    surface: 'store',
    tenantId: 't1',
    method: 'GET',
    path: '/slot',
    query: { slot: 'product-detail-reviews-section', route: 'prod-1' },
    headers: {},
    ...partial,
  };
}

interface ReviewListDescriptor {
  type: 'review-list';
  props: { items: Array<{ id: string; rating: number; body: string; createdAt: string }> };
}

function descriptor(res: ModuleHttpResponse): ReviewListDescriptor {
  return JSON.parse(res.body ?? 'null') as ReviewListDescriptor;
}

/** Seed reviews directly into the FakeTables store (bypassing the purchase gate). */
function seed(
  tables: FakeTables,
  rows: Array<{
    productId: string;
    rating: number;
    body: string;
    status: 'pending' | 'approved' | 'rejected';
  }>,
): void {
  let i = 0;
  for (const r of rows) {
    i += 1;
    tables.reviews.push({
      id: `r${i}`,
      customer_id: `cust-${i}`,
      product_id: r.productId,
      rating: r.rating,
      body: r.body,
      status: r.status,
      created_at: new Date(Date.UTC(2026, 0, i)).toISOString(),
    });
  }
}

describe('reviews slot — GET /slot (review-list descriptor)', () => {
  it('returns a review-list descriptor of APPROVED reviews for a valid route', async () => {
    const { deps, tables } = makeDeps();
    seed(tables, [
      { productId: 'prod-1', rating: 5, body: 'Excellent', status: 'approved' },
      { productId: 'prod-1', rating: 4, body: 'Good', status: 'approved' },
    ]);
    const res = await handleRequest(slotReq(), deps);
    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toContain('application/json');

    const d = descriptor(res);
    expect(d.type).toBe('review-list');
    expect(d.props.items).toHaveLength(2);
    for (const item of d.props.items) {
      expect(typeof item.id).toBe('string');
      expect(Number.isInteger(item.rating)).toBe(true);
      expect(item.rating).toBeGreaterThanOrEqual(1);
      expect(item.rating).toBeLessThanOrEqual(5);
      expect(typeof item.body).toBe('string');
      // C1 requires an ISO-8601 datetime string.
      expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('EXCLUDES pending and rejected reviews (approval filter holds on the slot read)', async () => {
    const { deps, tables } = makeDeps();
    seed(tables, [
      { productId: 'prod-1', rating: 5, body: 'Approved one', status: 'approved' },
      { productId: 'prod-1', rating: 1, body: 'Pending spam', status: 'pending' },
      { productId: 'prod-1', rating: 2, body: 'Rejected junk', status: 'rejected' },
    ]);
    const d = descriptor(await handleRequest(slotReq(), deps));
    expect(d.props.items).toHaveLength(1);
    expect(d.props.items[0]?.body).toBe('Approved one');
  });

  it('carries NO customer id / author in the descriptor (anonymous public read)', async () => {
    const { deps, tables } = makeDeps();
    seed(tables, [{ productId: 'prod-1', rating: 5, body: 'Nice', status: 'approved' }]);
    const res = await handleRequest(slotReq(), deps);
    const raw = res.body ?? '';
    expect(raw).not.toContain('customer');
    expect(raw).not.toContain('cust-');
    const item = descriptor(res).props.items[0] as Record<string, unknown>;
    expect(item).not.toHaveProperty('author');
  });

  it('204 when the slot query param is unknown (declines to render)', async () => {
    const { deps, tables } = makeDeps();
    seed(tables, [{ productId: 'prod-1', rating: 5, body: 'Nice', status: 'approved' }]);
    const res = await handleRequest(
      slotReq({ query: { slot: 'some-other-slot', route: 'prod-1' } }),
      deps,
    );
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
  });

  it('204 when the route (productId) is missing or invalid', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(
      slotReq({ query: { slot: 'product-detail-reviews-section' } }),
      deps,
    );
    expect(res.status).toBe(204);
  });

  it('declines to render when the module is disabled (non-200 ⇒ storefront renders nothing)', async () => {
    const { deps, tables } = makeDeps({ enabled: false });
    seed(tables, [{ productId: 'prod-1', rating: 5, body: 'Nice', status: 'approved' }]);
    const res = await handleRequest(slotReq(), deps);
    // A disabled module behaves as if it had no endpoints (existing 404), which C2 treats as decline.
    expect(res.status).not.toBe(200);
  });

  it('returns an empty-items descriptor when there are no approved reviews', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(slotReq(), deps);
    expect(res.status).toBe(200);
    expect(descriptor(res).props.items).toHaveLength(0);
  });

  it('bounds the descriptor body length to the C1 cap (truncates an over-long review body)', async () => {
    const { deps, tables } = makeDeps({ maxTextLen: 5000 });
    seed(tables, [{ productId: 'prod-1', rating: 5, body: 'x'.repeat(4000), status: 'approved' }]);
    const d = descriptor(await handleRequest(slotReq(), deps));
    expect(d.props.items[0]!.body.length).toBeLessThanOrEqual(REVIEW_BODY_MAX_LEN);
    expect(REVIEW_BODY_MAX_LEN).toBe(2000);
  });

  it('bounds the number of items to the C1 cap (max 50)', async () => {
    const { deps, tables } = makeDeps();
    seed(
      tables,
      Array.from({ length: 60 }, (_, i) => ({
        productId: 'prod-1',
        rating: 5,
        body: `review ${i}`,
        status: 'approved' as const,
      })),
    );
    const d = descriptor(await handleRequest(slotReq(), deps));
    expect(d.props.items.length).toBeLessThanOrEqual(REVIEW_LIST_MAX_ITEMS);
    expect(REVIEW_LIST_MAX_ITEMS).toBe(50);
  });
});
