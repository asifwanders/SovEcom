/**
 * Search integration tests.
 *
 * Boots the full AppModule against real Postgres + Redis + Meilisearch.
 * Creates products through the real admin API so event wiring is exercised.
 *
 * ASYNC INDEX SETTLEMENT: after any write, we await the Meilisearch task via
 * waitForIndex helper before asserting. This is essential because Meilisearch
 * is eventually consistent.
 *
 * CLEANUP: all test indexes are dropped in afterAll to avoid contamination.
 */
import request from 'supertest';
import type { Meilisearch } from 'meilisearch';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  AuthHarness,
  AUTH,
  newId,
} from '../auth/_auth-harness';
import { StoreTenantService } from '../../../src/catalog/store-tenant.service';
import { SearchService } from '../../../src/search/search.service';
import { ProductIndexer } from '../../../src/search/indexers/product.indexer';
import { AuthService } from '../../../src/auth/services/auth.service';
import { ResetService } from '../../../src/auth/services/reset.service';

const ADMIN_PRODUCTS = '/admin/v1/products';
const ADMIN_CATEGORIES = '/admin/v1/categories';
const STORE_SEARCH = '/store/v1/search';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function login(h: AuthHarness, email: string, password: string): Promise<string> {
  const res = await request(h.http()).post(AUTH.login).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** Insert a tenant without touching the default-tenant override. */
async function insertTenant(h: AuthHarness, slug?: string): Promise<string> {
  const id = newId();
  const s = slug ?? `tenant-${id.slice(-8)}`;
  await h.client`insert into tenants (id, name, slug) values (${id}, ${s}, ${s})`;
  return id;
}

type Cached = { defaultTenantId: string | null };

async function switchDefaultTenant(h: AuthHarness, id: string): Promise<void> {
  await h.client`
    insert into system_state (key, value)
    values ('default_tenant_id', to_jsonb(${id}::text))
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
  (h.app.get(AuthService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  (h.app.get(ResetService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  (h.app.get(StoreTenantService, { strict: false }) as unknown as Cached).defaultTenantId = null;
}

/**
 * Wait for the Meilisearch index for a tenant to settle after writes.
 * Polls until the search count matches `expectedMinCount` or times out.
 */
async function waitForIndex(
  client: Meilisearch,
  indexName: string,
  expectedMinCount: number,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stats = await client.index(indexName).getStats();
      if (stats.numberOfDocuments >= expectedMinCount) return;
    } catch {
      // index may not exist yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `waitForIndex timeout: ${indexName} did not reach ${expectedMinCount} docs within ${timeoutMs}ms`,
  );
}

/**
 * Wait until a product is ABSENT from the index (count <= expectedMaxCount).
 */
async function waitForIndexAbsent(
  client: Meilisearch,
  indexName: string,
  expectedMaxCount: number,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stats = await client.index(indexName).getStats();
      if (stats.numberOfDocuments <= expectedMaxCount) return;
    } catch {
      // index doesn't exist → count is 0
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `waitForIndexAbsent timeout: ${indexName} still has more than ${expectedMaxCount} docs after ${timeoutMs}ms`,
  );
}

/** Wait for a Meilisearch search to return at least one result matching predicate. */
async function waitForSearchResult(
  client: Meilisearch,
  indexName: string,
  query: string,
  predicate: (hits: Record<string, unknown>[]) => boolean,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await client.index(indexName).search(query);
      if (predicate(res.hits as Record<string, unknown>[])) return;
    } catch {
      // ok
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`waitForSearchResult timeout: query="${query}" in ${indexName}`);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('Search integration', () => {
  let h: AuthHarness;
  let meiliClient: Meilisearch;
  let searchSvc: SearchService;
  const cleanupIndexes: string[] = [];

  beforeAll(async () => {
    h = await bootAuthApp();
    searchSvc = h.app.get(SearchService, { strict: false });
    meiliClient = await searchSvc.getClient();
  });

  afterAll(async () => {
    // Drop all test indexes created during the suite.
    for (const idx of cleanupIndexes) {
      try {
        await meiliClient.deleteIndex(idx).waitTask();
      } catch {
        // ignore not-found
      }
    }
    await teardownAuthApp(h);
  });

  beforeEach(async () => {
    await resetAuthState(h);
    (h.app.get(StoreTenantService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  });

  // ── 1. Published product appears in search ────────────────────────────────────

  describe('published product → appears in /store/v1/search', () => {
    it('creates a PUBLISHED product and finds it in search by title', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const indexName = searchSvc.productsIndex(admin.tenantId);
      cleanupIndexes.push(indexName);

      const uniqueTitle = `Sovereign Tee ${newId().slice(-8)}`;

      // Create product (published)
      const res = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: uniqueTitle,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 2500, currency: 'EUR' }],
        })
        .expect(201);

      const productId: string = res.body.id;

      // Wait for the index to settle.
      await waitForIndex(meiliClient, indexName, 1);

      // Search via store endpoint.
      await switchDefaultTenant(h, admin.tenantId);
      const searchRes = await request(h.http())
        .get(`${STORE_SEARCH}?q=${encodeURIComponent('Sovereign')}`)
        .expect(200);

      const hits = searchRes.body.hits as Array<{ id: string; title: string }>;
      expect(hits.some((hit) => hit.id === productId)).toBe(true);
      // Ensure the hit has expected fields (allowlist check)
      const hit = hits.find((h) => h.id === productId)!;
      expect(hit.title).toBe(uniqueTitle);
      // Internal fields must NOT be present
      expect((hit as Record<string, unknown>)['tenantId']).toBeUndefined();
      expect((hit as Record<string, unknown>)['embedding']).toBeUndefined();
      expect((hit as Record<string, unknown>)['metadata']).toBeUndefined();
    });
  });

  // ── 2. Update title → reflected in index ─────────────────────────────────────

  describe('update product → index reflects change', () => {
    it('updates title and the index shows the new title', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const indexName = searchSvc.productsIndex(admin.tenantId);
      cleanupIndexes.push(indexName);

      const originalTitle = `Update Me ${newId().slice(-8)}`;
      const updatedTitle = `Updated Title ${newId().slice(-8)}`;

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: originalTitle,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 1000, currency: 'EUR' }],
        })
        .expect(201);

      await waitForIndex(meiliClient, indexName, 1);

      // PATCH the title
      await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: updatedTitle })
        .expect(200);

      // Wait for the updated title to appear
      await waitForSearchResult(meiliClient, indexName, '', (hits) =>
        hits.some((h) => h['id'] === created.body.id && h['title'] === updatedTitle),
      );

      await switchDefaultTenant(h, admin.tenantId);
      const searchRes = await request(h.http())
        .get(`${STORE_SEARCH}?q=${encodeURIComponent(updatedTitle.split(' ')[0]!)}`)
        .expect(200);
      const found = (searchRes.body.hits as Array<{ id: string; title: string }>).find(
        (h) => h.id === created.body.id,
      );
      expect(found?.title).toBe(updatedTitle);
    });
  });

  // ── 3. Archive product → removed from index ───────────────────────────────────

  describe('archive product → removed from search', () => {
    it('PATCHing status to archived removes the product from search', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const indexName = searchSvc.productsIndex(admin.tenantId);
      cleanupIndexes.push(indexName);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: `Archive Me ${newId().slice(-8)}`,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 1000, currency: 'EUR' }],
        })
        .expect(201);

      await waitForIndex(meiliClient, indexName, 1);

      // Archive it
      await request(h.http())
        .patch(`${ADMIN_PRODUCTS}/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'archived' })
        .expect(200);

      await waitForIndexAbsent(meiliClient, indexName, 0);

      await switchDefaultTenant(h, admin.tenantId);
      const searchRes = await request(h.http()).get(STORE_SEARCH).expect(200);
      const ids = (searchRes.body.hits as Array<{ id: string }>).map((h) => h.id);
      expect(ids).not.toContain(created.body.id);
    });
  });

  // ── 4. Delete product → removed from index ────────────────────────────────────

  describe('delete product → removed from search', () => {
    it('deleting a published product removes it from the index', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const indexName = searchSvc.productsIndex(admin.tenantId);
      cleanupIndexes.push(indexName);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: `Delete Me ${newId().slice(-8)}`,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 1000, currency: 'EUR' }],
        })
        .expect(201);

      await waitForIndex(meiliClient, indexName, 1);

      await request(h.http())
        .delete(`${ADMIN_PRODUCTS}/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      await waitForIndexAbsent(meiliClient, indexName, 0);

      await switchDefaultTenant(h, admin.tenantId);
      const searchRes = await request(h.http()).get(STORE_SEARCH).expect(200);
      const ids = (searchRes.body.hits as Array<{ id: string }>).map((h) => h.id);
      expect(ids).not.toContain(created.body.id);
    });
  });

  // ── 5. Draft product is NEVER in the index ────────────────────────────────────

  describe('draft product → never indexed', () => {
    it('a DRAFT product is never found in search', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const indexName = searchSvc.productsIndex(admin.tenantId);
      cleanupIndexes.push(indexName);

      const uniqueTitle = `Draft Only ${newId().slice(-8)}`;

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: uniqueTitle }) // status defaults to 'draft'
        .expect(201);

      // Wait a bit for any event that might erroneously index it
      await new Promise((r) => setTimeout(r, 1500));

      await switchDefaultTenant(h, admin.tenantId);
      const searchRes = await request(h.http())
        .get(`${STORE_SEARCH}?q=${encodeURIComponent(uniqueTitle.split(' ')[0]!)}`)
        .expect(200);

      const ids = (searchRes.body.hits as Array<{ id: string }>).map((h) => h.id);
      expect(ids).not.toContain(created.body.id);
    });
  });

  // ── 6. Tenant isolation ───────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it("tenant A's published product does not appear in tenant B's search results", async () => {
      // Create tenant A
      const adminA = await seedAdmin(h, { role: 'admin' });
      const indexNameA = searchSvc.productsIndex(adminA.tenantId);
      cleanupIndexes.push(indexNameA);

      // Create tenant B (insertTenant does NOT override the default)
      const tenantBId = await insertTenant(h);
      // Seed an admin for tenant B (not used directly but ensures the tenant has a user)
      await seedAdmin(h, { tenantId: tenantBId, role: 'admin' });
      const indexNameB = searchSvc.productsIndex(tenantBId);
      cleanupIndexes.push(indexNameB);

      const uniqueTitleA = `Tenant A Product ${newId().slice(-8)}`;

      // Switch default to tenant A and create a published product there
      await switchDefaultTenant(h, adminA.tenantId);
      const tokenALogin = await login(h, adminA.email, adminA.password);

      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${tokenALogin}`)
        .send({
          title: uniqueTitleA,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 1000, currency: 'EUR' }],
        })
        .expect(201);

      await waitForIndex(meiliClient, indexNameA, 1);

      // Now switch default to tenant B and search
      await switchDefaultTenant(h, tenantBId);
      const searchRes = await request(h.http())
        .get(`${STORE_SEARCH}?q=${encodeURIComponent('Tenant')}`)
        .expect(200);

      const ids = (searchRes.body.hits as Array<{ id: string; title: string }>).map((h) => h.title);
      // Tenant A's product title should NOT appear in tenant B's results
      expect(ids.some((t) => t === uniqueTitleA)).toBe(false);
    });
  });

  // ── 7. Faceted search: filter by category slug ────────────────────────────────

  describe('faceted search', () => {
    it('filter by category slug returns only matching products', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const indexName = searchSvc.productsIndex(admin.tenantId);
      cleanupIndexes.push(indexName);

      await switchDefaultTenant(h, admin.tenantId);

      // Create a category
      const catRes = await request(h.http())
        .post(ADMIN_CATEGORIES)
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Shirts', slug: `shirts-${newId().slice(-6)}` })
        .expect(201);
      const catId: string = catRes.body.id;
      const catSlug: string = catRes.body.slug;

      // Create two published products
      const prod1 = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: `Shirt Product ${newId().slice(-6)}`,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 1000, currency: 'EUR' }],
        })
        .expect(201);

      const prod2 = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: `Other Product ${newId().slice(-6)}`,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 2000, currency: 'EUR' }],
        })
        .expect(201);

      // Assign prod1 to the category. This emits product.updated (F1 fix), which
      // re-indexes prod1 with its new categorySlugs.
      await request(h.http())
        .put(`${ADMIN_PRODUCTS}/${prod1.body.id}/categories`)
        .set('Authorization', `Bearer ${token}`)
        .send({ categoryIds: [catId] })
        .expect(204);

      // Wait for both products to land.
      await waitForIndex(meiliClient, indexName, 2);
      // DETERMINISTIC (F1): await the re-index that carries the category slug,
      // instead of a fixed setTimeout. The assign now fires product.updated, so
      // prod1's doc will gain categorySlugs — poll until it does.
      await waitForSearchResult(meiliClient, indexName, '', (hits) =>
        hits.some(
          (hit) =>
            hit['id'] === prod1.body.id &&
            Array.isArray(hit['categorySlugs']) &&
            (hit['categorySlugs'] as unknown[]).includes(catSlug),
        ),
      );

      // Filter by the category slug
      const searchRes = await request(h.http())
        .get(`${STORE_SEARCH}?category=${encodeURIComponent(catSlug)}`)
        .expect(200);

      const hitIds = (searchRes.body.hits as Array<{ id: string }>).map((h) => h.id);
      expect(hitIds).toContain(prod1.body.id);
      expect(hitIds).not.toContain(prod2.body.id);
    });

    it('filter by price range returns only products within range', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const indexName = searchSvc.productsIndex(admin.tenantId);
      cleanupIndexes.push(indexName);

      await switchDefaultTenant(h, admin.tenantId);

      const cheap = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: `Cheap ${newId().slice(-6)}`,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 500, currency: 'EUR' }],
        })
        .expect(201);

      const expensive = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: `Expensive ${newId().slice(-6)}`,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 9000, currency: 'EUR' }],
        })
        .expect(201);

      await waitForIndex(meiliClient, indexName, 2);

      // Filter: only price ≤ 1000
      const res = await request(h.http()).get(`${STORE_SEARCH}?maxPrice=1000`).expect(200);

      const hits = res.body.hits as Array<{ id: string }>;
      expect(hits.some((h) => h.id === cheap.body.id)).toBe(true);
      expect(hits.some((h) => h.id === expensive.body.id)).toBe(false);
    });

    it('sort=price_asc returns cheapest first', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const indexName = searchSvc.productsIndex(admin.tenantId);
      cleanupIndexes.push(indexName);

      await switchDefaultTenant(h, admin.tenantId);

      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: `Mid Price ${newId().slice(-6)}`,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 5000, currency: 'EUR' }],
        })
        .expect(201);

      await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: `Low Price ${newId().slice(-6)}`,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 100, currency: 'EUR' }],
        })
        .expect(201);

      await waitForIndex(meiliClient, indexName, 2);

      const res = await request(h.http()).get(`${STORE_SEARCH}?sort=price_asc`).expect(200);

      const hits = res.body.hits as Array<{ priceAmount: number }>;
      expect(hits.length).toBeGreaterThanOrEqual(2);
      // Verify sorted ascending
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i]!.priceAmount).toBeGreaterThanOrEqual(hits[i - 1]!.priceAmount);
      }
    });
  });

  // ── 8. Garbage query params → 200, never 500 ──────────────────────────────────

  describe('input hardening', () => {
    it('garbage pageSize and price params return 200 (clamped), never 500', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      await switchDefaultTenant(h, admin.tenantId);

      // Various garbage inputs
      await request(h.http())
        .get(`${STORE_SEARCH}?pageSize=abc&minPrice=xyz&maxPrice=-99&page=0`)
        .expect(200);

      await request(h.http()).get(`${STORE_SEARCH}?sort=INVALID_SORT&pageSize=999999`).expect(200);
    });

    it('tracking params (utm_source/fbclid/gclid) are ignored, not rejected (F5)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      await switchDefaultTenant(h, admin.tenantId);

      // Shared store URLs routinely carry tracking junk. These must NOT 400.
      const res = await request(h.http())
        .get(
          `${STORE_SEARCH}?q=tee&utm_source=newsletter&utm_medium=email&fbclid=abc123&gclid=xyz789`,
        )
        .expect(200);

      // The known params still parse (q applied), unknown keys silently stripped.
      expect(res.body).toHaveProperty('hits');
      expect(res.body).toHaveProperty('page', 1);
    });
  });

  // ── 9. Reindex script rebuilds an emptied index ───────────────────────────────

  describe('reindex', () => {
    it('reindexTenant rebuilds an emptied index from Postgres', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const indexName = searchSvc.productsIndex(admin.tenantId);
      cleanupIndexes.push(indexName);

      await switchDefaultTenant(h, admin.tenantId);

      const created = await request(h.http())
        .post(ADMIN_PRODUCTS)
        .set('Authorization', `Bearer ${token}`)
        .send({
          title: `Reindex Me ${newId().slice(-8)}`,
          status: 'published',
          variants: [{ sku: `sku-${newId().slice(-6)}`, priceAmount: 1500, currency: 'EUR' }],
        })
        .expect(201);

      await waitForIndex(meiliClient, indexName, 1);

      // Manually wipe the index to simulate drift
      await meiliClient.index(indexName).deleteAllDocuments().waitTask();
      const statsBefore = await meiliClient.index(indexName).getStats();
      expect(statsBefore.numberOfDocuments).toBe(0);

      // Run reindex via ProductIndexer
      const indexer = h.app.get(ProductIndexer, { strict: false });
      const { indexed } = await indexer.reindexTenant(admin.tenantId);
      expect(indexed).toBeGreaterThanOrEqual(1);

      // Doc should reappear
      await waitForIndex(meiliClient, indexName, 1);
      const statsAfter = await meiliClient.index(indexName).getStats();
      expect(statsAfter.numberOfDocuments).toBeGreaterThanOrEqual(1);

      // Verify the specific product is searchable
      await switchDefaultTenant(h, admin.tenantId);
      const searchRes = await request(h.http())
        .get(`${STORE_SEARCH}?q=${encodeURIComponent('Reindex')}`)
        .expect(200);

      const ids = (searchRes.body.hits as Array<{ id: string }>).map((h) => h.id);
      expect(ids).toContain(created.body.id);
    });
  });

  // ── 10. Index-failure: handler logs, does NOT crash ────────────────────────────

  describe('index-failure resilience', () => {
    it('a Meilisearch failure in the event handler logs but does not throw', async () => {
      // This tests the contract from the spec: get the ProductIndexer and call its
      // handler directly with a broken search service.
      const admin = await seedAdmin(h, { role: 'admin' });

      // Use a db stub that returns a published product for the load call
      const dbStub = {
        db: {
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue([
              {
                id: 'some-id',
                tenantId: admin.tenantId,
                title: 'T',
                description: null,
                slug: 'test',
                status: 'published',
                createdAt: new Date(),
              },
            ]),
          }),
        },
      } as unknown as import('../../../src/database/database.service').DatabaseService;

      const fakeIndexer = new ProductIndexer(
        {
          getClient: async () => {
            throw new Error('simulated Meilisearch outage');
          },
          productsIndex: (tid: string) => `${tid}_products`,
        } as unknown as SearchService,
        dbStub,
        {} as unknown as import('../../../src/storage/storage.service').StorageService,
      );

      // Must not throw
      await expect(
        fakeIndexer.onProductCreated({
          tenantId: admin.tenantId,
          productId: 'some-id',
          title: 'T',
          status: 'published',
        } as never),
      ).resolves.toBeUndefined();
    });
  });
});
