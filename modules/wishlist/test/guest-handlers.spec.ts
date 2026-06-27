/**
 * wishlist -- guest handler tests (Decision 074).
 *
 * Tests the guest identity path: add/remove/list with a guestId, the slot showing for guests,
 * merge-on-login (idempotent, dedupe-safe), and security invariants (guest cannot merge without
 * a customer, customer wins over guest, merge reads guestId from req not body).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ModuleHttpRequest } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { WishlistRepository } from '../src/db/repository';
import { resolveSettings } from '../src/settings';
import { handleWishlistSlot } from '../src/slot/wishlist-slot';
import { FakeTables, FakeStore } from './_mock-sdk';

const CUST = 'cust-123';
const GUEST = 'guest-uuid-a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function req(partial: Partial<ModuleHttpRequest>): ModuleHttpRequest {
  return {
    surface: 'store',
    method: 'GET',
    path: '/items',
    query: {},
    headers: {},
    tenantId: 't1',
    ...partial,
  };
}

function setup(over: Partial<HandlerDeps> = {}): { deps: HandlerDeps; tables: FakeTables } {
  const tables = new FakeTables();
  const deps: HandlerDeps = {
    repo: new WishlistRepository(tables),
    store: new FakeStore(),
    settings: resolveSettings({ enabled: true, maxItemsPerCustomer: 100 }),
    ...over,
  };
  return { deps, tables };
}

async function parse(resBody: string | undefined): Promise<unknown> {
  return resBody ? JSON.parse(resBody) : undefined;
}

describe('guest wishlist handlers', () => {
  let tables: FakeTables;
  let deps: HandlerDeps;

  beforeEach(() => {
    ({ deps, tables } = setup());
  });

  describe('no identity (no customer, no guestId)', () => {
    it('POST /items -> 401 login_required', async () => {
      const res = await handleRequest(
        req({ method: 'POST', path: '/items', body: JSON.stringify({ productVariantId: 'v1' }) }),
        deps,
      );
      expect(res.status).toBe(401);
      expect(await parse(res.body)).toEqual({ error: 'login_required' });
    });

    it('GET /items -> 401', async () => {
      const res = await handleRequest(req({ method: 'GET', path: '/items' }), deps);
      expect(res.status).toBe(401);
    });

    it('DELETE /items/v1 -> 401', async () => {
      const res = await handleRequest(req({ method: 'DELETE', path: '/items/v1' }), deps);
      expect(res.status).toBe(401);
    });
  });

  describe('guest add', () => {
    it('guest adds a variant -> 201, stored in guest table', async () => {
      const res = await handleRequest(
        req({
          method: 'POST',
          path: '/items',
          body: JSON.stringify({ productVariantId: 'v1' }),
          guestId: { id: GUEST },
        }),
        deps,
      );
      expect(res.status).toBe(201);
      expect(tables.guestItems).toHaveLength(1);
      expect(tables.guestItems[0]).toMatchObject({ guest_id: GUEST, product_variant_id: 'v1' });
      // Customer table must be untouched.
      expect(tables.items).toHaveLength(0);
    });

    it('guest add is idempotent -> second add returns 200, no duplicate', async () => {
      const add = () =>
        handleRequest(
          req({
            method: 'POST',
            path: '/items',
            body: JSON.stringify({ productVariantId: 'v1' }),
            guestId: { id: GUEST },
          }),
          deps,
        );
      expect((await add()).status).toBe(201);
      expect((await add()).status).toBe(200);
      expect(tables.guestItems).toHaveLength(1);
    });

    it('customer wins over guestId -- stored in customer table, NOT guest table', async () => {
      await handleRequest(
        req({
          method: 'POST',
          path: '/items',
          body: JSON.stringify({ productVariantId: 'v1' }),
          customer: { id: CUST },
          guestId: { id: GUEST }, // both present -- customer wins
        }),
        deps,
      );
      expect(tables.items).toHaveLength(1);
      expect(tables.items[0]?.customer_id).toBe(CUST);
      expect(tables.guestItems).toHaveLength(0);
    });

    it('guest max cap is enforced', async () => {
      const { deps: d, tables: t } = setup({
        settings: resolveSettings({ maxItemsPerCustomer: 2 }),
      });
      const add = (v: string) =>
        handleRequest(
          req({
            method: 'POST',
            path: '/items',
            body: JSON.stringify({ productVariantId: v }),
            guestId: { id: GUEST },
          }),
          d,
        );
      expect((await add('v1')).status).toBe(201);
      expect((await add('v2')).status).toBe(201);
      const third = await add('v3');
      expect(third.status).toBe(409);
      expect(t.guestItems).toHaveLength(2);
    });
  });

  describe('guest toggle alias (bodyless)', () => {
    it('POST /items/:id/add -> 201 for guest', async () => {
      const res = await handleRequest(
        req({ method: 'POST', path: '/items/v1/add', guestId: { id: GUEST } }),
        deps,
      );
      expect(res.status).toBe(201);
      expect(tables.guestItems).toHaveLength(1);
    });

    it('POST /items/:id/remove -> 204 for guest (after add)', async () => {
      await handleRequest(
        req({ method: 'POST', path: '/items/v1/add', guestId: { id: GUEST } }),
        deps,
      );
      const res = await handleRequest(
        req({ method: 'POST', path: '/items/v1/remove', guestId: { id: GUEST } }),
        deps,
      );
      expect(res.status).toBe(204);
      expect(tables.guestItems).toHaveLength(0);
    });
  });

  describe('guest remove', () => {
    it('DELETE /items/:id -> 204 after guest add', async () => {
      await handleRequest(
        req({
          method: 'POST',
          path: '/items',
          body: JSON.stringify({ productVariantId: 'v1' }),
          guestId: { id: GUEST },
        }),
        deps,
      );
      const res = await handleRequest(
        req({ method: 'DELETE', path: '/items/v1', guestId: { id: GUEST } }),
        deps,
      );
      expect(res.status).toBe(204);
      expect(tables.guestItems).toHaveLength(0);
    });

    it('DELETE /items/:id -> 404 for non-existent guest item', async () => {
      const res = await handleRequest(
        req({ method: 'DELETE', path: '/items/nope', guestId: { id: GUEST } }),
        deps,
      );
      expect(res.status).toBe(404);
    });

    it("guest B cannot delete guest A's item", async () => {
      const GUEST_B = 'guest-bbbbb-different';
      await handleRequest(
        req({
          method: 'POST',
          path: '/items',
          body: JSON.stringify({ productVariantId: 'v1' }),
          guestId: { id: GUEST },
        }),
        deps,
      );
      const res = await handleRequest(
        req({ method: 'DELETE', path: '/items/v1', guestId: { id: GUEST_B } }),
        deps,
      );
      expect(res.status).toBe(404);
      expect(tables.guestItems).toHaveLength(1);
    });
  });

  describe('guest list', () => {
    it("lists only the guest's items", async () => {
      const GUEST_B = 'guest-bbbbb-different';
      // Guest A adds v1; Guest B adds v2.
      for (const [gid, v] of [[GUEST, 'v1'] as const, [GUEST_B, 'v2'] as const]) {
        await handleRequest(
          req({
            method: 'POST',
            path: '/items',
            body: JSON.stringify({ productVariantId: v }),
            guestId: { id: gid },
          }),
          deps,
        );
      }
      const res = await handleRequest(
        req({ method: 'GET', path: '/items', guestId: { id: GUEST } }),
        deps,
      );
      expect(res.status).toBe(200);
      const body = (await parse(res.body)) as { items: Array<{ productVariantId: string }> };
      const variants = body.items.map((i) => i.productVariantId);
      expect(variants).toEqual(['v1']); // not v2 (guest B's)
    });
  });

  describe('merge-guest', () => {
    it('merges guest items into customer after login', async () => {
      // Guest adds two items.
      for (const v of ['v1', 'v2']) {
        await handleRequest(
          req({
            method: 'POST',
            path: '/items',
            body: JSON.stringify({ productVariantId: v }),
            guestId: { id: GUEST },
          }),
          deps,
        );
      }
      expect(tables.guestItems).toHaveLength(2);

      // Merge: customer authenticated + guest cookie present.
      const res = await handleRequest(
        req({
          method: 'POST',
          path: '/merge-guest',
          customer: { id: CUST },
          guestId: { id: GUEST },
        }),
        deps,
      );
      expect(res.status).toBe(200);
      const body = (await parse(res.body)) as { merged: number };
      expect(body.merged).toBe(2);

      // Guest items deleted; customer items present.
      expect(tables.guestItems).toHaveLength(0);
      expect(tables.items).toHaveLength(2);
      expect(tables.items.every((i) => i.customer_id === CUST)).toBe(true);
    });

    it('merge is idempotent (dedupes)', async () => {
      // Customer already has v1.
      await handleRequest(
        req({
          method: 'POST',
          path: '/items',
          body: JSON.stringify({ productVariantId: 'v1' }),
          customer: { id: CUST },
        }),
        deps,
      );
      // Guest also has v1 + v2.
      for (const v of ['v1', 'v2']) {
        await handleRequest(
          req({
            method: 'POST',
            path: '/items',
            body: JSON.stringify({ productVariantId: v }),
            guestId: { id: GUEST },
          }),
          deps,
        );
      }
      // Merge.
      const res = await handleRequest(
        req({
          method: 'POST',
          path: '/merge-guest',
          customer: { id: CUST },
          guestId: { id: GUEST },
        }),
        deps,
      );
      expect(res.status).toBe(200);

      // Only 2 unique variants in the customer table (v1 deduplicated).
      const listRes = await handleRequest(
        req({ method: 'GET', path: '/items', customer: { id: CUST } }),
        deps,
      );
      const listBody = (await parse(listRes.body)) as {
        items: Array<{ productVariantId: string }>;
      };
      const variants = listBody.items.map((i) => i.productVariantId).sort();
      expect(variants).toEqual(['v1', 'v2']);
    });

    it('merge with no guest items returns merged:0', async () => {
      const res = await handleRequest(
        req({
          method: 'POST',
          path: '/merge-guest',
          customer: { id: CUST },
          guestId: { id: GUEST },
        }),
        deps,
      );
      expect(res.status).toBe(200);
      expect(await parse(res.body)).toEqual({ merged: 0 });
    });

    it('merge without customer -> 401 (anonymous cannot trigger merge)', async () => {
      const res = await handleRequest(
        req({ method: 'POST', path: '/merge-guest', guestId: { id: GUEST } }),
        deps,
      );
      expect(res.status).toBe(401);
    });

    it('merge without guestId -> merged:0 (nothing to merge)', async () => {
      const res = await handleRequest(
        req({ method: 'POST', path: '/merge-guest', customer: { id: CUST } }),
        deps,
      );
      expect(res.status).toBe(200);
      expect(await parse(res.body)).toEqual({ merged: 0 });
    });
  });
});

describe('guest wishlist slot', () => {
  it('returns a toggle-button descriptor for a guest with initialOn=false', async () => {
    const { deps: d } = setup();
    const res = await handleWishlistSlot(
      req({
        method: 'GET',
        path: '/slot',
        query: { slot: 'product-card-actions', route: 'p1' },
        guestId: { id: GUEST },
      }),
      d.repo,
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body ?? '{}') as {
      type: string;
      props: { initialOn: boolean };
    };
    expect(body.type).toBe('toggle-button');
    expect(body.props.initialOn).toBe(false);
  });

  it('returns initialOn=true after guest adds the product', async () => {
    const { deps: d } = setup();
    // Guest adds p1.
    await handleRequest(
      req({
        method: 'POST',
        path: '/items',
        body: JSON.stringify({ productVariantId: 'p1' }),
        guestId: { id: GUEST },
      }),
      d,
    );
    const res = await handleWishlistSlot(
      req({
        method: 'GET',
        path: '/slot',
        query: { slot: 'product-card-actions', route: 'p1' },
        guestId: { id: GUEST },
      }),
      d.repo,
    );
    const body = JSON.parse(res.body ?? '{}') as { props: { initialOn: boolean } };
    expect(body.props.initialOn).toBe(true);
  });

  it('returns 204 for no viewer (no customer, no guestId)', async () => {
    const { deps: d } = setup();
    const res = await handleWishlistSlot(
      req({ method: 'GET', path: '/slot', query: { slot: 'product-card-actions', route: 'p1' } }),
      d.repo,
    );
    expect(res.status).toBe(204);
  });
});
