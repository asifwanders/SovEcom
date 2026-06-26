/**
 * wishlist — slot data-RPC handler tests (mocked SDK).
 *
 * `GET /slot?slot=product-card-actions&route=<productId>` returns a personalized `toggle-button`
 * widget descriptor — data only. The toggle reflects whether the route's product is wishlisted
 * by the verified customer (`req.customer.id`):
 *   - anonymous (no verified customer) → 204 (a wishlist needs an account);
 *   - signed in → `{ initialOn, onAction, offAction, labels, icon:'heart' }` where `initialOn` is
 *     the customer's current wishlist state and both action paths target this module's own mount
 *     (`/store/v1/modules/wishlist/...`);
 *   - the toggle POSTs back with no body, so the action paths carry the product id in the path
 *     (path-based add/remove aliases), not a JSON body.
 *
 * The storefront island re-pins the action paths to the binding module; these tests
 * assert the handler emits own-mount paths to begin with. The descriptor's C1-contract validity is
 * checked end-to-end by the apps/api integration suite (an AGPL module never imports the MIT theme-sdk).
 */
import { describe, it, expect } from 'vitest';
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { WishlistRepository } from '../src/db/repository';
import { resolveSettings, type WishlistSettings } from '../src/settings';
import { FakeTables, FakeStore } from './_mock-sdk';

const CUST = { id: 'cust-1' };
const PROD = 'prod-1';

function makeDeps(settings?: Partial<WishlistSettings>): { deps: HandlerDeps; tables: FakeTables } {
  const tables = new FakeTables();
  const deps: HandlerDeps = {
    repo: new WishlistRepository(tables),
    store: new FakeStore(),
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
    query: { slot: 'product-card-actions', route: PROD },
    headers: {},
    ...partial,
  };
}

interface ToggleDescriptor {
  type: 'toggle-button';
  props: {
    initialOn: boolean;
    onAction: { path: string };
    offAction: { path: string };
    labels: { on: string; off: string };
    icon: string;
  };
}

function descriptor(res: ModuleHttpResponse): ToggleDescriptor {
  return JSON.parse(res.body ?? 'null') as ToggleDescriptor;
}

describe('wishlist slot — GET /slot (toggle-button descriptor)', () => {
  it('204 for an anonymous visitor (a wishlist needs an account)', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(slotReq(), deps);
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
  });

  it('signed-in, NOT wishlisted → initialOn:false, own-mount add/remove paths, heart icon', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(slotReq({ customer: CUST }), deps);
    expect(res.status).toBe(200);
    const d = descriptor(res);
    expect(d.type).toBe('toggle-button');
    expect(d.props.initialOn).toBe(false);
    expect(d.props.icon).toBe('heart');
    expect(d.props.onAction.path.startsWith('/store/v1/modules/wishlist/')).toBe(true);
    expect(d.props.offAction.path.startsWith('/store/v1/modules/wishlist/')).toBe(true);
    // The product id rides in the PATH (the toggle posts no body).
    expect(d.props.onAction.path).toContain(encodeURIComponent(PROD));
    expect(d.props.offAction.path).toContain(encodeURIComponent(PROD));
    // No other module / origin / traversal.
    expect(d.props.onAction.path).not.toContain('..');
    expect(d.props.offAction.path).not.toMatch(/^https?:|^\/\//);
  });

  it('signed-in, ALREADY wishlisted → initialOn:true', async () => {
    const { deps, tables } = makeDeps();
    await new WishlistRepository(tables).add(CUST.id, PROD);
    const res = await handleRequest(slotReq({ customer: CUST }), deps);
    expect(descriptor(res).props.initialOn).toBe(true);
  });

  it('is CUSTOMER-SCOPED: another customer with this product wishlisted does NOT flip initialOn', async () => {
    const { deps, tables } = makeDeps();
    await new WishlistRepository(tables).add('cust-OTHER', PROD);
    const res = await handleRequest(slotReq({ customer: CUST }), deps);
    expect(descriptor(res).props.initialOn).toBe(false);
  });

  it('204 when the slot query param is unknown', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(
      slotReq({ customer: CUST, query: { slot: 'other', route: PROD } }),
      deps,
    );
    expect(res.status).toBe(204);
  });

  it('204 when the route (productId) is missing/invalid', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(
      slotReq({ customer: CUST, query: { slot: 'product-card-actions' } }),
      deps,
    );
    expect(res.status).toBe(204);
  });

  it('declines to render when the module is disabled (non-200)', async () => {
    const { deps } = makeDeps({ enabled: false });
    const res = await handleRequest(slotReq({ customer: CUST }), deps);
    expect(res.status).not.toBe(200);
  });
});

describe('wishlist — POST path-based add/remove (toggle-button back-ends)', () => {
  it('POST /items/:id/add adds the product for the customer (idempotent)', async () => {
    const { deps, tables } = makeDeps();
    const res = await handleRequest(
      { ...slotReq({ customer: CUST }), method: 'POST', path: `/items/${PROD}/add` },
      deps,
    );
    expect([200, 201, 204]).toContain(res.status);
    expect(await new WishlistRepository(tables).has(CUST.id, PROD)).toBe(true);
  });

  it('POST /items/:id/add is anonymous-401', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(
      { ...slotReq(), method: 'POST', path: `/items/${PROD}/add` },
      deps,
    );
    expect(res.status).toBe(401);
  });

  it('POST /items/:id/remove removes the product for the customer', async () => {
    const { deps, tables } = makeDeps();
    await new WishlistRepository(tables).add(CUST.id, PROD);
    const res = await handleRequest(
      { ...slotReq({ customer: CUST }), method: 'POST', path: `/items/${PROD}/remove` },
      deps,
    );
    expect([200, 204]).toContain(res.status);
    expect(await new WishlistRepository(tables).has(CUST.id, PROD)).toBe(false);
  });

  it('POST /items/:id/remove is anonymous-401', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(
      { ...slotReq(), method: 'POST', path: `/items/${PROD}/remove` },
      deps,
    );
    expect(res.status).toBe(401);
  });

  it("customer B cannot remove customer A's item via POST /items/:id/remove (isolation)", async () => {
    const { deps, tables } = makeDeps();
    await new WishlistRepository(tables).add('cust-A', PROD);
    const res = await handleRequest(
      { ...slotReq({ customer: { id: 'cust-B' } }), method: 'POST', path: `/items/${PROD}/remove` },
      deps,
    );
    expect(res.status).toBe(404); // not visible to B
    expect(await new WishlistRepository(tables).has('cust-A', PROD)).toBe(true); // A's item untouched
  });

  it('rejects a path id that decodes to contain a separator (e.g. %2F) → 404, never reaches the repo', async () => {
    const { deps, tables } = makeDeps();
    // `%2Fetc%2Fpasswd` decodes to `/etc/passwd` — a decoded id with a slash is never a valid id.
    const res = await handleRequest(
      { ...slotReq({ customer: CUST }), method: 'POST', path: `/items/%2Fetc%2Fpasswd/add` },
      deps,
    );
    expect(res.status).toBe(404);
    expect(tables.items).toHaveLength(0);
  });
});
