/**
 * reviews — slot DATA integration test.
 *
 * Proves the end-to-end contract: the module's `GET /slot` body is a descriptor the storefront's
 * `parseWidget` (from `@sovecom/theme-sdk`) accepts and narrows to `review-list`. A 204 decline
 * yields an empty body that `parseWidget` rejects, which is also correct.
 */
import { describe, it, expect } from 'vitest';
import { parseWidget } from '@sovecom/theme-sdk';
import type { ModuleHttpRequest } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { ReviewsRepository } from '../src/db/repository';
import { resolveSettings } from '../src/settings';
import { FakeTables, FakeCommerce, FakeStore } from './_mock-sdk';

function makeDeps(): { deps: HandlerDeps; tables: FakeTables } {
  const tables = new FakeTables();
  const deps: HandlerDeps = {
    repo: new ReviewsRepository(tables),
    products: new FakeStore().products,
    commerce: new FakeCommerce(() => true),
    settings: resolveSettings(),
  };
  return { deps, tables };
}

const slotReq = (query: Record<string, string>): ModuleHttpRequest => ({
  surface: 'store',
  tenantId: 't1',
  method: 'GET',
  path: '/slot',
  query,
  headers: {},
});

describe('reviews slot — parseWidget integration', () => {
  it('GET /slot body parseWidget-validates to a review-list descriptor', async () => {
    const { deps, tables } = makeDeps();
    tables.reviews.push({
      id: 'r1',
      customer_id: 'c1',
      product_id: 'prod-1',
      rating: 5,
      body: 'Great',
      status: 'approved',
      created_at: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    });
    const res = await handleRequest(
      slotReq({ slot: 'product-detail-reviews-section', route: 'prod-1' }),
      deps,
    );
    expect(res.status).toBe(200);
    const widget = parseWidget(res.body);
    expect(widget).not.toBeNull();
    expect(widget?.type).toBe('review-list');
  });

  it('a 204 decline produces no parseWidget-valid descriptor (renders nothing)', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(slotReq({ slot: 'unknown-slot', route: 'prod-1' }), deps);
    expect(res.status).toBe(204);
    expect(parseWidget(res.body ?? '')).toBeNull();
  });
});
