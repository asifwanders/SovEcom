/**
 * Unit tests — the wishlist HTTP handlers against a MOCKED SDK. Covers add/remove/list,
 * the not-logged-in 401 path, max-items enforcement, idempotent add, and list enrichment.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ModuleHttpRequest } from '@sovecom/module-sdk';
import { handleRequest, type HandlerDeps } from '../src/api/handlers';
import { WishlistRepository } from '../src/db/repository';
import { resolveSettings } from '../src/settings';
import { FakeTables, FakeStore } from './_mock-sdk';

const CUST_A = 'cust-a';
const CUST_B = 'cust-b';

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

function deps(over: Partial<HandlerDeps> = {}): { deps: HandlerDeps; tables: FakeTables } {
  const tables = over.repo ? (undefined as never) : new FakeTables();
  const d: HandlerDeps = {
    repo: over.repo ?? new WishlistRepository(tables),
    store: over.store ?? new FakeStore(),
    settings: over.settings ?? resolveSettings({ enabled: true, maxItemsPerCustomer: 100 }),
  };
  return { deps: d, tables };
}

async function parse(resBody: string | undefined): Promise<unknown> {
  return resBody ? JSON.parse(resBody) : undefined;
}

describe('wishlist handlers', () => {
  let tables: FakeTables;
  let d: HandlerDeps;

  beforeEach(() => {
    const built = deps();
    tables = built.tables;
    d = built.deps;
  });

  describe('not logged in (no req.customer)', () => {
    it('POST /items → 401 login_required', async () => {
      const res = await handleRequest(
        req({ method: 'POST', path: '/items', body: JSON.stringify({ productVariantId: 'v1' }) }),
        d,
      );
      expect(res.status).toBe(401);
      expect(await parse(res.body)).toEqual({ error: 'login_required' });
      expect(tables.items).toHaveLength(0);
    });

    it('GET /items → 401', async () => {
      const res = await handleRequest(req({ method: 'GET', path: '/items' }), d);
      expect(res.status).toBe(401);
    });

    it('DELETE /items/v1 → 401', async () => {
      const res = await handleRequest(req({ method: 'DELETE', path: '/items/v1' }), d);
      expect(res.status).toBe(401);
    });
  });

  describe('add', () => {
    it('adds for the verified customer → 201', async () => {
      const res = await handleRequest(
        req({
          method: 'POST',
          path: '/items',
          body: JSON.stringify({ productVariantId: 'v1' }),
          customer: { id: CUST_A },
        }),
        d,
      );
      expect(res.status).toBe(201);
      expect(tables.items).toHaveLength(1);
      expect(tables.items[0]).toMatchObject({ customer_id: CUST_A, product_variant_id: 'v1' });
    });

    it('is idempotent — re-adding the same variant → 200, no duplicate', async () => {
      const add = () =>
        handleRequest(
          req({
            method: 'POST',
            path: '/items',
            body: JSON.stringify({ productVariantId: 'v1' }),
            customer: { id: CUST_A },
          }),
          d,
        );
      expect((await add()).status).toBe(201);
      expect((await add()).status).toBe(200);
      expect(tables.items).toHaveLength(1);
    });

    it('rejects a missing/blank productVariantId → 400', async () => {
      const res = await handleRequest(
        req({ method: 'POST', path: '/items', body: JSON.stringify({}), customer: { id: CUST_A } }),
        d,
      );
      expect(res.status).toBe(400);
    });

    it('uses ONLY req.customer.id — a customer id in the body is ignored', async () => {
      await handleRequest(
        req({
          method: 'POST',
          path: '/items',
          body: JSON.stringify({
            productVariantId: 'v1',
            customerId: CUST_B,
            customer: { id: CUST_B },
          }),
          customer: { id: CUST_A },
        }),
        d,
      );
      expect(tables.items[0]?.customer_id).toBe(CUST_A);
    });
  });

  describe('max items', () => {
    it('blocks adding past the cap → 409', async () => {
      const built = deps({ settings: resolveSettings({ maxItemsPerCustomer: 2 }) });
      tables = built.tables;
      d = built.deps;
      const add = (v: string) =>
        handleRequest(
          req({
            method: 'POST',
            path: '/items',
            body: JSON.stringify({ productVariantId: v }),
            customer: { id: CUST_A },
          }),
          d,
        );
      expect((await add('v1')).status).toBe(201);
      expect((await add('v2')).status).toBe(201);
      const third = await add('v3');
      expect(third.status).toBe(409);
      expect(await parse(third.body)).toMatchObject({
        error: 'max_items_reached',
        maxItemsPerCustomer: 2,
      });
      expect(tables.items).toHaveLength(2);
    });

    it('re-adding an existing item does NOT count against the cap', async () => {
      const built = deps({ settings: resolveSettings({ maxItemsPerCustomer: 1 }) });
      tables = built.tables;
      d = built.deps;
      const add = (v: string) =>
        handleRequest(
          req({
            method: 'POST',
            path: '/items',
            body: JSON.stringify({ productVariantId: v }),
            customer: { id: CUST_A },
          }),
          d,
        );
      expect((await add('v1')).status).toBe(201);
      expect((await add('v1')).status).toBe(200); // idempotent, still allowed at cap
    });
  });

  describe('remove', () => {
    it("removes the customer's item → 204 (bodyless, RFC 7230)", async () => {
      await handleRequest(
        req({
          method: 'POST',
          path: '/items',
          body: JSON.stringify({ productVariantId: 'v1' }),
          customer: { id: CUST_A },
        }),
        d,
      );
      const res = await handleRequest(
        req({ method: 'DELETE', path: '/items/v1', customer: { id: CUST_A } }),
        d,
      );
      expect(res.status).toBe(204);
      // A 204 must carry no body and no content-type.
      expect(res.body).toBeUndefined();
      expect(res.headers).toBeUndefined();
      expect(tables.items).toHaveLength(0);
    });

    it('a malformed percent-escape in the path → 404 (no URIError / 500)', async () => {
      const res = await handleRequest(
        req({ method: 'DELETE', path: '/items/%zz', customer: { id: CUST_A } }),
        d,
      );
      expect(res.status).toBe(404);
    });

    it('removing a non-existent item → 404', async () => {
      const res = await handleRequest(
        req({ method: 'DELETE', path: '/items/nope', customer: { id: CUST_A } }),
        d,
      );
      expect(res.status).toBe(404);
    });

    it("customer B cannot remove customer A's item", async () => {
      await handleRequest(
        req({
          method: 'POST',
          path: '/items',
          body: JSON.stringify({ productVariantId: 'v1' }),
          customer: { id: CUST_A },
        }),
        d,
      );
      const res = await handleRequest(
        req({ method: 'DELETE', path: '/items/v1', customer: { id: CUST_B } }),
        d,
      );
      expect(res.status).toBe(404); // not visible to B
      expect(tables.items).toHaveLength(1); // A's item untouched
    });
  });

  describe('list + enrichment', () => {
    it("lists only the caller's items, enriched with product info", async () => {
      const store = new FakeStore({
        v1: { id: 'v1', slug: 'red-shirt', title: 'Red Shirt', status: 'active' },
      });
      const built = deps({ store });
      tables = built.tables;
      d = built.deps;

      // A adds v1 (known) + v2 (unknown product); B adds v3.
      for (const v of ['v1', 'v2']) {
        await handleRequest(
          req({
            method: 'POST',
            path: '/items',
            body: JSON.stringify({ productVariantId: v }),
            customer: { id: CUST_A },
          }),
          d,
        );
      }
      await handleRequest(
        req({
          method: 'POST',
          path: '/items',
          body: JSON.stringify({ productVariantId: 'v3' }),
          customer: { id: CUST_B },
        }),
        d,
      );

      const res = await handleRequest(
        req({ method: 'GET', path: '/items', customer: { id: CUST_A } }),
        d,
      );
      expect(res.status).toBe(200);
      const body = (await parse(res.body)) as {
        items: Array<{ productVariantId: string; product: unknown }>;
      };
      const variants = body.items.map((i) => i.productVariantId).sort();
      expect(variants).toEqual(['v1', 'v2']); // not v3 (B's)
      const v1 = body.items.find((i) => i.productVariantId === 'v1');
      expect(v1?.product).toMatchObject({ slug: 'red-shirt', title: 'Red Shirt' });
      const v2 = body.items.find((i) => i.productVariantId === 'v2');
      expect(v2?.product).toBeNull(); // unknown product degrades gracefully
    });
  });

  describe('disabled module', () => {
    it('returns 404 for every route when settings.enabled is false', async () => {
      const built = deps({ settings: resolveSettings({ enabled: false }) });
      d = built.deps;
      const res = await handleRequest(
        req({ method: 'GET', path: '/items', customer: { id: CUST_A } }),
        d,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('unknown routes', () => {
    it('unmatched method/path → 404', async () => {
      const res = await handleRequest(
        req({ method: 'PUT', path: '/whatever', customer: { id: CUST_A } }),
        d,
      );
      expect(res.status).toBe(404);
    });
  });
});
