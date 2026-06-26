/**
 * wishlist — slot DATA integration test. Verifies the module's `GET /slot` body validates to a
 * `toggle-button` descriptor via the theme-sdk validator, and that the descriptor's own-mount
 * action paths validate against the strict action-path schema.
 */
import { describe, it, expect } from 'vitest';
import { parseWidget } from '@sovecom/theme-sdk';
import type { ModuleHttpRequest } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { WishlistRepository } from '../src/db/repository';
import { resolveSettings } from '../src/settings';
import { FakeTables, FakeStore } from './_mock-sdk';

function makeDeps(): { deps: HandlerDeps; tables: FakeTables } {
  const tables = new FakeTables();
  const deps: HandlerDeps = {
    repo: new WishlistRepository(tables),
    store: new FakeStore(),
    settings: resolveSettings(),
  };
  return { deps, tables };
}

const slotReq = (query: Record<string, string>, customer?: { id: string }): ModuleHttpRequest => ({
  surface: 'store',
  tenantId: 't1',
  method: 'GET',
  path: '/slot',
  query,
  headers: {},
  ...(customer ? { customer } : {}),
});

describe('wishlist slot — parseWidget integration', () => {
  it('signed-in GET /slot body parseWidget-validates to a toggle-button (own-mount action paths pass C1)', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(
      slotReq({ slot: 'product-card-actions', route: 'prod-1' }, { id: 'cust-1' }),
      deps,
    );
    expect(res.status).toBe(200);
    const widget = parseWidget(res.body);
    expect(widget).not.toBeNull();
    expect(widget?.type).toBe('toggle-button');
    if (widget?.type === 'toggle-button') {
      // C1's actionPathSchema only admits clean relative /store/v1/modules/... paths.
      expect(widget.props.onAction.path).toMatch(/^\/store\/v1\/modules\/wishlist\//);
      expect(widget.props.offAction.path).toMatch(/^\/store\/v1\/modules\/wishlist\//);
    }
  });

  it('an anonymous 204 decline produces no parseWidget-valid descriptor', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(
      slotReq({ slot: 'product-card-actions', route: 'prod-1' }),
      deps,
    );
    expect(res.status).toBe(204);
    expect(parseWidget(res.body ?? '')).toBeNull();
  });
});
