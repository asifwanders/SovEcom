/**
 * recently-viewed — slot DATA integration test. Verifies the module's `GET /slot` body validates
 * to a `product-carousel` descriptor via the theme-sdk validator.
 */
import { describe, it, expect } from 'vitest';
import { parseWidget } from '@sovecom/theme-sdk';
import type { ModuleHttpRequest } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { RecentlyViewedRepository } from '../src/db/repository';
import { resolveSettings } from '../src/settings';
import { FakeTables, FakeStore, FakeCategoryResolver } from './_mock-sdk';

const GUEST_ID = { id: 'guest-uuid-integration-test' };

function makeDeps(): { deps: HandlerDeps; tables: FakeTables } {
  const tables = new FakeTables();
  const deps: HandlerDeps = {
    repo: new RecentlyViewedRepository(tables),
    products: new FakeStore().products,
    categoryResolver: new FakeCategoryResolver(),
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
  guestId: GUEST_ID,
});

describe('recently-viewed slot — parseWidget integration', () => {
  it('GET /slot body parseWidget-validates to a product-carousel descriptor', async () => {
    const { deps, tables } = makeDeps();
    tables.views.push({
      id: 'v1',
      viewer_key: `guest:${GUEST_ID.id}`,
      product_id: 'p1',
      viewed_at: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    });
    const res = await handleRequest(slotReq({ slot: 'home-page-bottom', route: '/' }), deps);
    expect(res.status).toBe(200);
    const widget = parseWidget(res.body);
    expect(widget).not.toBeNull();
    expect(widget?.type).toBe('product-carousel');
  });

  it('an empty-history 204 decline produces no parseWidget-valid descriptor', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(slotReq({ slot: 'home-page-bottom', route: '/' }), deps);
    expect(res.status).toBe(204);
    expect(parseWidget(res.body ?? '')).toBeNull();
  });
});
