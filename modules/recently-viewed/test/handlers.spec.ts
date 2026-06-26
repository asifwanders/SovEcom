/**
 * recently-viewed — handler unit tests (mocked SDK). Drives the REAL handleRequest + repository +
 * identity + category-filter against the in-memory FakeTables / FakeStore / FakeCategoryResolver.
 */
import { describe, it, expect } from 'vitest';
import type { ModuleHttpRequest, ModuleHttpResponse } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { RecentlyViewedRepository } from '../src/db/repository';
import { resolveSettings, type RecentlyViewedSettings } from '../src/settings';
import { CUSTOMER_KEY_PREFIX, GUEST_KEY_PREFIX } from '../src/identity/viewer';
import {
  excludeNothingResolver,
  type ProductCategoryResolver,
} from '../src/category/category-filter';
import { FakeTables, FakeStore, FakeCategoryResolver } from './_mock-sdk';

function makeDeps(
  overrides: {
    settings?: Partial<RecentlyViewedSettings>;
    store?: FakeStore;
    categoryResolver?: ProductCategoryResolver;
    verifyProductExists?: boolean;
  } = {},
): { deps: HandlerDeps; tables: FakeTables; store: FakeStore } {
  const tables = new FakeTables();
  const store = overrides.store ?? new FakeStore();
  const deps: HandlerDeps = {
    repo: new RecentlyViewedRepository(tables),
    products: store.products,
    categoryResolver: overrides.categoryResolver ?? excludeNothingResolver,
    settings: resolveSettings(overrides.settings),
    verifyProductExists: overrides.verifyProductExists,
  };
  return { deps, tables, store };
}

function req(partial: Partial<ModuleHttpRequest>): ModuleHttpRequest {
  return {
    surface: 'store',
    tenantId: 't1',
    method: 'GET',
    path: '/recent',
    query: {},
    headers: {},
    ...partial,
  };
}

const CUST = { id: 'cust-1' };
const GUEST_ID = { id: 'guest-uuid-abc' };

async function body(res: ModuleHttpResponse): Promise<Record<string, unknown>> {
  return res.body ? (JSON.parse(res.body) as Record<string, unknown>) : {};
}

/** Record a view as a given customer; returns the response. */
async function postView(
  deps: HandlerDeps,
  customer: { id: string } | undefined,
  productId: unknown,
  extra: Partial<ModuleHttpRequest> = {},
): Promise<ModuleHttpResponse> {
  return handleRequest(
    req({
      method: 'POST',
      path: '/views',
      customer,
      body: JSON.stringify({ productId }),
      ...extra,
    }),
    deps,
  );
}

describe('recently-viewed handlers — record view (POST /views)', () => {
  it('anonymous (no customer, no guestId) → 401 login_required', async () => {
    const { deps } = makeDeps();
    const res = await postView(deps, undefined, 'prod-1');
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: 'login_required' });
  });

  it('a logged-in customer → 204 and the view is stored', async () => {
    const { deps, tables } = makeDeps();
    const res = await postView(deps, CUST, 'prod-1');
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
    expect(tables.views).toHaveLength(1);
    expect(tables.views[0]).toMatchObject({
      viewer_key: `${CUSTOMER_KEY_PREFIX}cust-1`,
      product_id: 'prod-1',
    });
  });

  it('a guest via core-derived guestId → 204, stored under the guest: key', async () => {
    const { deps, tables } = makeDeps();
    const res = await postView(deps, undefined, 'prod-1', { guestId: GUEST_ID });
    expect(res.status).toBe(204);
    expect(tables.views[0]).toMatchObject({
      viewer_key: `${GUEST_KEY_PREFIX}${GUEST_ID.id}`,
      product_id: 'prod-1',
    });
  });

  it('x-rv-guest header is IGNORED — client-supplied guest tokens are no longer accepted', async () => {
    // Old scheme: the storefront supplied a token via x-rv-guest header. Now that path is removed;
    // without a real guestId cookie the request is anonymous → 401.
    const { deps } = makeDeps();
    const res = await postView(deps, undefined, 'prod-1', {
      headers: { 'x-rv-guest': 'a'.repeat(32) },
    });
    expect(res.status).toBe(401);
  });

  it('?guest= query param is IGNORED — client-supplied guest tokens are no longer accepted', async () => {
    const { deps } = makeDeps();
    const res = await postView(deps, undefined, 'prod-1', { query: { guest: 'a'.repeat(32) } });
    expect(res.status).toBe(401);
  });

  it('invalid productId → 400 invalid_product_id', async () => {
    const { deps } = makeDeps();
    expect((await postView(deps, CUST, '')).status).toBe(400);
    expect((await postView(deps, CUST, '   ')).status).toBe(400);
    expect((await postView(deps, CUST, 42)).status).toBe(400);
    expect((await postView(deps, CUST, 'x'.repeat(65))).status).toBe(400);
  });

  it('productId with a control char → clean 400 (not a 500 from a NUL in a bound param)', async () => {
    const { deps, tables } = makeDeps();
    // Escapes only — no raw control bytes in source.
    expect((await postView(deps, CUST, 'prod\x00id')).status).toBe(400);
    expect((await postView(deps, CUST, 'prod\x1fid')).status).toBe(400);
    expect((await postView(deps, CUST, 'prod\x7fid')).status).toBe(400);
    expect(tables.views).toHaveLength(0);
  });

  it('re-viewing the same product dedupes (no second row) and bumps it to newest', async () => {
    const { deps, tables } = makeDeps();
    await postView(deps, CUST, 'prod-1');
    await postView(deps, CUST, 'prod-2');
    await postView(deps, CUST, 'prod-1'); // re-view bumps prod-1 above prod-2
    expect(tables.views).toHaveLength(2);

    const list = await handleRequest(req({ path: '/recent', customer: CUST }), deps);
    const items = (await body(list)).items as Array<{ productId: string }>;
    expect(items.map((i) => i.productId)).toEqual(['prod-1', 'prod-2']);
  });

  it('verifyProductExists on + unknown product → 404 product_not_found', async () => {
    const { deps, tables } = makeDeps({
      store: new FakeStore(new Set(['prod-known'])),
      verifyProductExists: true,
    });
    const res = await postView(deps, CUST, 'prod-unknown');
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: 'product_not_found' });
    expect(tables.views).toHaveLength(0);
  });

  it('verifyProductExists on + known product → 204 stored', async () => {
    const { deps, tables } = makeDeps({
      store: new FakeStore(new Set(['prod-known'])),
      verifyProductExists: true,
    });
    expect((await postView(deps, CUST, 'prod-known')).status).toBe(204);
    expect(tables.views).toHaveLength(1);
  });
});

describe('recently-viewed handlers — list recent (GET /recent)', () => {
  it('an unresolved viewer → 200 with an empty list (no 401, leaks nothing)', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(req({ path: '/recent' }), deps);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ items: [] });
  });

  it('returns the viewer-s products newest-first, capped at maxItems', async () => {
    const { deps } = makeDeps({ settings: { maxItems: 2 } });
    for (const p of ['p1', 'p2', 'p3']) await postView(deps, CUST, p); // p3 newest
    const res = await handleRequest(req({ path: '/recent', customer: CUST }), deps);
    const items = (await body(res)).items as Array<{ productId: string }>;
    expect(items.map((i) => i.productId)).toEqual(['p3', 'p2']);
  });

  it('excludes the ?exclude product (the one currently on screen)', async () => {
    const { deps } = makeDeps();
    for (const p of ['p1', 'p2', 'p3']) await postView(deps, CUST, p);
    const res = await handleRequest(
      req({ path: '/recent', customer: CUST, query: { exclude: 'p3' } }),
      deps,
    );
    const items = (await body(res)).items as Array<{ productId: string }>;
    expect(items.map((i) => i.productId)).toEqual(['p2', 'p1']);
  });

  it('excludes products whose category is in excludeCategories (via the resolver seam)', async () => {
    const resolver = new FakeCategoryResolver(
      new Map([
        ['p1', ['cat-hidden']],
        ['p2', ['cat-ok']],
        ['p3', ['cat-hidden']],
      ]),
    );
    const { deps } = makeDeps({
      settings: { excludeCategories: ['cat-hidden'] },
      categoryResolver: resolver,
    });
    for (const p of ['p1', 'p2', 'p3']) await postView(deps, CUST, p);
    const res = await handleRequest(req({ path: '/recent', customer: CUST }), deps);
    const items = (await body(res)).items as Array<{ productId: string }>;
    // p1 + p3 are in the hidden category → only p2 survives.
    expect(items.map((i) => i.productId)).toEqual(['p2']);
  });

  it('enriches each item with catalog info (title/slug/status), null when gone', async () => {
    const { deps } = makeDeps({ store: new FakeStore(new Set(['p1'])) });
    await postView(deps, CUST, 'p1');
    await postView(deps, CUST, 'p-gone');
    const res = await handleRequest(req({ path: '/recent', customer: CUST }), deps);
    const items = (await body(res)).items as Array<{
      productId: string;
      product: { title: string } | null;
    }>;
    const byId = new Map(items.map((i) => [i.productId, i]));
    expect(byId.get('p1')!.product).toMatchObject({ slug: 'slug-p1', title: 'Product p1' });
    expect(byId.get('p-gone')!.product).toBeNull();
  });

  it('a failed enrichment never drops the entry (degrades to product: null)', async () => {
    const { deps } = makeDeps({ store: new FakeStore(null, true) });
    await postView(deps, CUST, 'p1');
    const res = await handleRequest(req({ path: '/recent', customer: CUST }), deps);
    const items = (await body(res)).items as Array<{ productId: string; product: unknown }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ productId: 'p1', product: null });
  });

  it('a guest reads their own history via core-derived guestId', async () => {
    const { deps } = makeDeps();
    await postView(deps, undefined, 'g-prod', { guestId: GUEST_ID });
    const res = await handleRequest(req({ path: '/recent', guestId: GUEST_ID }), deps);
    const items = (await body(res)).items as Array<{ productId: string }>;
    expect(items.map((i) => i.productId)).toEqual(['g-prod']);
  });
});

describe('recently-viewed handlers — per-viewer isolation', () => {
  it("viewer A's GET never returns viewer B's views (customers)", async () => {
    const { deps } = makeDeps();
    await postView(deps, { id: 'A' }, 'a-prod');
    await postView(deps, { id: 'B' }, 'b-prod');

    const a = await handleRequest(req({ path: '/recent', customer: { id: 'A' } }), deps);
    const b = await handleRequest(req({ path: '/recent', customer: { id: 'B' } }), deps);
    expect(((await body(a)).items as Array<{ productId: string }>).map((i) => i.productId)).toEqual(
      ['a-prod'],
    );
    expect(((await body(b)).items as Array<{ productId: string }>).map((i) => i.productId)).toEqual(
      ['b-prod'],
    );
  });

  it('a guest only ever sees their own guestId-scoped history', async () => {
    const { deps } = makeDeps();
    const g1 = { id: 'guest-id-1' };
    const g2 = { id: 'guest-id-2' };
    await postView(deps, undefined, 'g1-prod', { guestId: g1 });
    await postView(deps, undefined, 'g2-prod', { guestId: g2 });

    const r1 = await handleRequest(req({ path: '/recent', guestId: g1 }), deps);
    expect(
      ((await body(r1)).items as Array<{ productId: string }>).map((i) => i.productId),
    ).toEqual(['g1-prod']);
  });

  it('a customer and a guest with the same raw id cannot cross-read (namespace isolation)', async () => {
    const { deps } = makeDeps();
    const sharedRawId = 'shared-raw-id-xyz';
    // Record a view as a customer with that id.
    await postView(deps, { id: sharedRawId }, 'cust-prod');
    // Record a different view as a guest with the same raw id.
    await postView(deps, undefined, 'guest-prod', { guestId: { id: sharedRawId } });

    // The customer sees only their product.
    const custRes = await handleRequest(
      req({ path: '/recent', customer: { id: sharedRawId } }),
      deps,
    );
    const custItems = ((await body(custRes)).items as Array<{ productId: string }>).map(
      (i) => i.productId,
    );
    expect(custItems).toEqual(['cust-prod']);

    // The guest sees only their product.
    const guestRes = await handleRequest(
      req({ path: '/recent', guestId: { id: sharedRawId } }),
      deps,
    );
    const guestItems = ((await body(guestRes)).items as Array<{ productId: string }>).map(
      (i) => i.productId,
    );
    expect(guestItems).toEqual(['guest-prod']);
  });
});

describe('recently-viewed handlers — merge-guest (POST /merge-guest)', () => {
  async function postMergeGuest(
    deps: HandlerDeps,
    customer: { id: string } | undefined,
    guestId: { id: string } | undefined,
  ): Promise<ModuleHttpResponse> {
    return handleRequest(req({ method: 'POST', path: '/merge-guest', customer, guestId }), deps);
  }

  it('no customer (anonymous) → 401 login_required', async () => {
    const { deps } = makeDeps();
    const res = await postMergeGuest(deps, undefined, GUEST_ID);
    expect(res.status).toBe(401);
    expect(await body(res)).toEqual({ error: 'login_required' });
  });

  it('customer present but no guestId cookie → 200 { merged: 0 } (idempotent)', async () => {
    const { deps } = makeDeps();
    const res = await postMergeGuest(deps, CUST, undefined);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ merged: 0 });
  });

  it('migrates guest history to the customer key space', async () => {
    const { deps, tables } = makeDeps();
    // Record two views as a guest.
    await postView(deps, undefined, 'g-prod-1', { guestId: GUEST_ID });
    await postView(deps, undefined, 'g-prod-2', { guestId: GUEST_ID });
    expect(tables.views).toHaveLength(2);

    // Merge.
    const res = await postMergeGuest(deps, CUST, GUEST_ID);
    expect(res.status).toBe(200);
    expect((await body(res)).merged).toBe(2);

    // All rows should now be under the customer key, none under the guest key.
    const custKey = `${CUSTOMER_KEY_PREFIX}${CUST.id}`;
    const guestKey = `${GUEST_KEY_PREFIX}${GUEST_ID.id}`;
    expect(tables.views.every((r) => r.viewer_key === custKey)).toBe(true);
    expect(tables.views.some((r) => r.viewer_key === guestKey)).toBe(false);
  });

  it('merge is idempotent — duplicate products in both keys are deduped (not doubled)', async () => {
    const { deps, tables } = makeDeps();
    // The customer already viewed prod-X.
    await postView(deps, CUST, 'prod-X');
    // The guest also viewed prod-X, plus prod-Y.
    await postView(deps, undefined, 'prod-X', { guestId: GUEST_ID });
    await postView(deps, undefined, 'prod-Y', { guestId: GUEST_ID });
    expect(tables.views).toHaveLength(3);

    // Merge.
    const res = await postMergeGuest(deps, CUST, GUEST_ID);
    expect(res.status).toBe(200);

    // After merge: only 2 rows remain (prod-X deduped, prod-Y added), no guest rows.
    const custKey = `${CUSTOMER_KEY_PREFIX}${CUST.id}`;
    const custViews = tables.views.filter((r) => r.viewer_key === custKey);
    expect(custViews.map((r) => r.product_id).sort()).toEqual(['prod-X', 'prod-Y']);
    expect(tables.views.some((r) => r.viewer_key.startsWith('guest:'))).toBe(false);
  });

  it('after merge the guest list is empty and the customer list has the migrated items', async () => {
    const { deps } = makeDeps();
    await postView(deps, undefined, 'g-prod', { guestId: GUEST_ID });
    await postMergeGuest(deps, CUST, GUEST_ID);

    // Guest list is empty.
    const guestList = await handleRequest(req({ path: '/recent', guestId: GUEST_ID }), deps);
    expect(((await body(guestList)).items as unknown[]).length).toBe(0);

    // Customer list has the merged item.
    const custList = await handleRequest(req({ path: '/recent', customer: CUST }), deps);
    const custItems = (await body(custList)).items as Array<{ productId: string }>;
    expect(custItems.map((i) => i.productId)).toContain('g-prod');
  });
});

describe('recently-viewed repository — row-cap (MAX_ROWS_PER_VIEWER)', () => {
  it('recordView prunes oldest rows beyond the cap for the same viewer', async () => {
    const tables = new FakeTables();
    const repo = new RecentlyViewedRepository(tables);
    const viewerKey = `${GUEST_KEY_PREFIX}cap-test-guest`;

    // Insert MAX_ROWS_PER_VIEWER + 5 distinct products for the same viewer.
    // We access the cap value indirectly: insert 105 rows and confirm only 100 remain.
    const OVER_CAP = 105;
    for (let i = 0; i < OVER_CAP; i++) {
      await repo.recordView(viewerKey, `product-${i}`);
    }

    const viewerRows = tables.views.filter((r) => r.viewer_key === viewerKey);
    expect(viewerRows.length).toBeLessThanOrEqual(100);
  });

  it('recordView does NOT prune rows for a DIFFERENT viewer', async () => {
    const tables = new FakeTables();
    const repo = new RecentlyViewedRepository(tables);
    const viewerA = `${GUEST_KEY_PREFIX}viewer-a`;
    const viewerB = `${GUEST_KEY_PREFIX}viewer-b`;

    // Seed viewer B with 5 rows.
    for (let i = 0; i < 5; i++) {
      await repo.recordView(viewerB, `b-prod-${i}`);
    }
    const bRowsBefore = tables.views.filter((r) => r.viewer_key === viewerB).length;

    // Now exceed the cap for viewer A.
    for (let i = 0; i < 105; i++) {
      await repo.recordView(viewerA, `a-prod-${i}`);
    }

    // Viewer B's rows must be untouched.
    const bRowsAfter = tables.views.filter((r) => r.viewer_key === viewerB).length;
    expect(bRowsAfter).toBe(bRowsBefore);
  });

  it('recordView keeps newest rows when pruning', async () => {
    const tables = new FakeTables();
    const repo = new RecentlyViewedRepository(tables);
    const viewerKey = `${GUEST_KEY_PREFIX}cap-order-guest`;

    // Insert 105 products; the last 100 inserted should be the ones kept (newest viewed_at).
    for (let i = 0; i < 105; i++) {
      await repo.recordView(viewerKey, `product-${i}`);
    }

    const keptIds = new Set(
      tables.views.filter((r) => r.viewer_key === viewerKey).map((r) => r.product_id),
    );
    // The first 5 (oldest) should have been pruned.
    for (let i = 0; i < 5; i++) {
      expect(keptIds.has(`product-${i}`)).toBe(false);
    }
    // The last 100 should be retained.
    for (let i = 5; i < 105; i++) {
      expect(keptIds.has(`product-${i}`)).toBe(true);
    }
  });
});

describe('recently-viewed handlers — routing', () => {
  it('a disabled module → 404 on every route', async () => {
    const { deps } = makeDeps({ settings: { enabled: false } });
    expect((await handleRequest(req({ path: '/recent', customer: CUST }), deps)).status).toBe(404);
    expect((await postView(deps, CUST, 'p1')).status).toBe(404);
  });

  it('the admin surface matches nothing → 404 (this module is store-only)', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(
      req({ surface: 'admin', method: 'GET', path: '/recent', customer: CUST }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  it('an unknown path → 404 not_found', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(req({ method: 'GET', path: '/nope', customer: CUST }), deps);
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: 'not_found' });
  });
});
