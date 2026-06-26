/**
 * Minimal SearchService smoke test.
 *
 * NOTE: SearchModule now imports AuthModule and CatalogModule (for event wiring and
 * store endpoints), so it can no longer be booted in isolation.
 * This test uses AppModule (same as all other integration tests) and retrieves
 * SearchService from the full application context.
 */
import { bootAuthApp, teardownAuthApp } from './auth/_auth-harness';
import type { AuthHarness } from './auth/_auth-harness';
import { SearchService } from '../../src/search/search.service';

describe('search (integration)', () => {
  let h: AuthHarness;
  let service: SearchService;

  beforeAll(async () => {
    h = await bootAuthApp();
    service = h.app.get(SearchService, { strict: false });
  });

  afterAll(async () => {
    await teardownAuthApp(h);
  });

  it('reports the Meilisearch instance as available', async () => {
    expect(await service.ping()).toBe(true);
  });

  it('creates an index, indexes and finds a document, then cleans up', async () => {
    const client = await service.getClient();
    const uid = `int_products_${Date.now()}`;

    // v0.58: index-mutating calls return an EnqueuedTaskPromise with .waitTask()
    await client.createIndex(uid, { primaryKey: 'id' }).waitTask();
    await client
      .index(uid)
      .addDocuments([{ id: '1', title: 'Sovereign Tee' }])
      .waitTask();

    const res = await client.index(uid).search('sovereign');
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits[0].id).toBe('1');

    await client.deleteIndex(uid).waitTask();
  });
});
