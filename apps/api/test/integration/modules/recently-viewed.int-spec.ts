/**
 * ii — Recently-viewed reference module END-TO-END integration (real Postgres, real
 * runtime). Mirrors reviews.int-spec.ts / wishlist.int-spec.ts / notify-back-in-stock.int-spec.ts.
 *
 * Installs the actual `modules/recently-viewed` module and drives it through the REAL module runtime:
 *   - provision the module's PG schema + low-privilege role, open its dedicated connection;
 *   - wire a REAL ModuleBroker (real read adapter for product enrichment + existence, real SQL
 *     executor) over an in-memory RPC channel pair;
 *   - build the worker-side SDK and run the module's OWN migration so `mod_recently-viewed_views` is
 *     created in its schema; mount the handler with the same deps the module's activate() wires;
 *   - drive the mounted endpoint over `http.handle` exactly as the proxy would.
 *
 * CATEGORY-EXCLUSION: `ModuleProductDto.category` now carries the product's primary category,
 * so `excludeCategories` resolves end-to-end through the real read port. This suite seeds a real
 * category + a product→category link and drives the exclude with the module's DEFAULT
 * `storeProductCategoryResolver` (no stub). A second test still exercises the INJECTED resolver
 * seam to prove it stays stubbable. The product-EXISTENCE guard (read:products) is also driven
 * end-to-end.
 *
 * The HTTP-proxy→forked-worker path is intentionally NOT used (the runtime forks a compiled
 * dist/worker-entry.js that does not exist under ts-jest). This suite exercises the same broker +
 * SDK + `http.handle` contract over an in-memory peer pair, the established real-runtime pattern.
 */
import { and, eq } from 'drizzle-orm';

import {
  bootAuthApp,
  teardownAuthApp,
  AuthHarness,
  DEFAULT_TENANT_ID,
  newId,
} from '../auth/_auth-harness';
import { AuditService } from '../../../src/audit/audit.service';
import { DatabaseService } from '../../../src/database/database.service';
import { products } from '../../../src/database/schema/products';
import { categories } from '../../../src/database/schema/categories';
import { productCategories } from '../../../src/database/schema/product_categories';
import { RpcPeer } from '../../../src/modules/runtime/rpc';
import { createInMemoryChannelPair } from '../../../src/modules/runtime/worker-channel';
import { createModuleSdk } from '../../../src/modules/runtime/worker-sdk';
import { ModuleBroker, type BrokerContext } from '../../../src/modules/runtime/module-broker';
import type { ModulePermission } from '../../../src/modules/module-manifest';
import { BrokerReadAdapter } from '../../../src/modules/runtime/broker-read.adapter';
import { ModuleDbProvisioner } from '../../../src/modules/runtime/module-db.provisioner';
import { ModuleSqlExecutor } from '../../../src/modules/runtime/module-sql.executor';
import {
  ModuleMailPort,
  FixedWindowRateLimiter,
} from '../../../src/modules/runtime/module-mail.port';
import type { IMailService } from '../../../src/mail/mail.service';
import type { ModuleHttpRequest, ModuleHttpResponse, ModuleSdk } from '@sovecom/module-sdk';

// The module under test. ts-jest resolves the workspace package to its TS source.
import { MIGRATION_STATEMENTS } from '../../../../../modules/recently-viewed/src/db/schema';
import { RecentlyViewedRepository } from '../../../../../modules/recently-viewed/src/db/repository';
import { handleRequest } from '../../../../../modules/recently-viewed/src/api/handlers';
import { resolveSettings } from '../../../../../modules/recently-viewed/src/settings';
import {
  excludeNothingResolver,
  storeProductCategoryResolver,
  type ProductCategoryResolver,
} from '../../../../../modules/recently-viewed/src/category/category-filter';

const MOD = 'recently-viewed';
const TENANT = DEFAULT_TENANT_ID;
// Hyphenated module name → the table identifier must be double-quoted in raw SQL.
const TABLE = '"mod_recently-viewed_views"';
const GUEST_TOKEN = 'guest-' + 'x'.repeat(20);

interface Harness {
  corePeer: RpcPeer;
  workerPeer: RpcPeer;
  sdk: ModuleSdk;
  dispose: () => void;
}

describe('Recently-viewed module end-to-end (integration, real PG)', () => {
  let h: AuthHarness;
  let db: DatabaseService;
  let provisioner: ModuleDbProvisioner;
  let executor: ModuleSqlExecutor;
  let audit: AuditService;
  const productIds: string[] = [];
  let hiddenCategoryId: string; // productIds[1] (beta) belongs to this category

  beforeAll(async () => {
    h = await bootAuthApp();
    db = h.app.get(DatabaseService);
    audit = h.app.get(AuditService);
    provisioner = new ModuleDbProvisioner(db);
    executor = new ModuleSqlExecutor(db);

    await provisioner.deprovision(MOD).catch(() => undefined);
    await provisioner.provision(MOD);
    executor.open(MOD, await provisioner.rotateCredential(MOD));

    // Seed a few products so read:products enrichment + the existence guard resolve through the real
    // read adapter.
    for (const slug of ['rv-alpha', 'rv-beta', 'rv-gamma']) {
      await db.db
        .insert(products)
        .values({ tenantId: TENANT, title: `RV ${slug}`, slug, status: 'published' })
        .onConflictDoNothing();
      const [row] = await db.db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.tenantId, TENANT), eq(products.slug, slug)))
        .limit(1);
      productIds.push(row!.id);
    }

    // A category that productIds[1] (beta) belongs to — so the DEFAULT resolver can resolve it from
    // ModuleProductDto.category and the exclude works end-to-end. Idempotent (the persistent dev
    // DB reuses the same fixture across runs, like the products above): insert-or-find the category +
    // the M2M link with onConflictDoNothing so a re-run does not collide.
    await db.db
      .insert(categories)
      .values({ tenantId: TENANT, name: 'Hidden Cat', slug: 'rv-hidden', position: 0 })
      .onConflictDoNothing();
    const [cat] = await db.db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.tenantId, TENANT), eq(categories.slug, 'rv-hidden')))
      .limit(1);
    hiddenCategoryId = cat!.id;
    await db.db
      .insert(productCategories)
      .values({ tenantId: TENANT, productId: productIds[1]!, categoryId: hiddenCategoryId })
      .onConflictDoNothing();

    // Run the module's real migration once into its schema (idempotent).
    for (const sql of MIGRATION_STATEMENTS) await executor.exec(MOD, sql);
  });

  afterAll(async () => {
    await executor.close(MOD).catch(() => undefined);
    await provisioner.deprovision(MOD).catch(() => undefined);
    await teardownAuthApp(h);
  });

  beforeEach(async () => {
    await executor.exec(MOD, `TRUNCATE TABLE ${TABLE}`).catch(() => undefined);
  });

  /** Wire a real broker (read adapter + executor) over an RPC pair and build the worker SDK. */
  function wire(grants: ModulePermission[]): Harness {
    const mail: IMailService = {
      send: async () => ({ messageId: 'm-int' }),
    } as unknown as IMailService;
    const mailPort = new ModuleMailPort(mail, audit, new FixedWindowRateLimiter(100, 60_000));
    const readPorts = new BrokerReadAdapter(db);

    const broker = new ModuleBroker(
      readPorts,
      { fetch: () => Promise.reject(new Error('no egress')) } as never,
      executor,
      { subscribe() {}, emitModuleEvent() {}, unsubscribe() {} } as never,
      mailPort,
    );

    const [core, worker] = createInMemoryChannelPair();
    const corePeer = new RpcPeer(core, { requestTimeoutMs: 5000 });
    const workerPeer = new RpcPeer(worker, { requestTimeoutMs: 5000 });
    const ctx: BrokerContext = {
      tenantId: TENANT,
      moduleName: MOD,
      grantedPermissions: new Set<ModulePermission>(grants),
      httpAllowlist: new Set<string>(),
    };
    broker.registerOn(corePeer, ctx);

    const sdk = createModuleSdk(workerPeer);
    return {
      corePeer,
      workerPeer,
      sdk,
      dispose: () => {
        corePeer.dispose();
        workerPeer.dispose();
      },
    };
  }

  const ALL_GRANTS: ModulePermission[] = ['read:products', 'write:own_tables'];

  /** Mount the recently-viewed handler with the given settings + resolver; return a request driver. */
  function serve(
    env: Harness,
    opts: {
      settingsBag?: unknown;
      categoryResolver?: ProductCategoryResolver;
      verifyProductExists?: boolean;
    } = {},
  ): (partial: Partial<ModuleHttpRequest>) => Promise<ModuleHttpResponse> {
    const repo = new RecentlyViewedRepository(env.sdk.tables);
    const deps = {
      repo,
      products: env.sdk.store.products,
      categoryResolver: opts.categoryResolver ?? excludeNothingResolver,
      settings: resolveSettings(opts.settingsBag ?? { enabled: true }),
      verifyProductExists: opts.verifyProductExists,
    };
    env.sdk.serve((req) => handleRequest(req, deps));
    return (partial: Partial<ModuleHttpRequest>) => {
      const req: ModuleHttpRequest = {
        surface: 'store',
        tenantId: TENANT,
        method: 'GET',
        path: '/recent',
        query: {},
        headers: {},
        ...partial,
      };
      return env.corePeer.request('http.handle', req) as Promise<ModuleHttpResponse>;
    };
  }

  function idsOf(res: ModuleHttpResponse): string[] {
    const parsed = JSON.parse(res.body!) as { items: Array<{ productId: string }> };
    return parsed.items.map((i) => i.productId);
  }

  it('authenticated customer: POST views then GET recent returns them newest-first, capped, deduped', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env, { settingsBag: { enabled: true, maxItems: 2 } });
      const cust = { id: 'cust-' + newId() };

      // View alpha, beta, gamma, then re-view alpha (dedupe + bump to newest).
      for (const pid of productIds) {
        const res = await call({
          method: 'POST',
          path: '/views',
          customer: cust,
          body: JSON.stringify({ productId: pid }),
        });
        expect(res.status).toBe(204);
      }
      const review = await call({
        method: 'POST',
        path: '/views',
        customer: cust,
        body: JSON.stringify({ productId: productIds[0] }),
      });
      expect(review.status).toBe(204);

      // Only ONE row per (viewer, product): 3 products viewed, not 4. The stored key is the
      // cust:-namespaced viewer key, never the bare customer id.
      const stored = await executor.exec(
        MOD,
        `SELECT product_id FROM ${TABLE} WHERE viewer_key = $1`,
        [`cust:${cust.id}`],
      );
      expect(stored.rows).toHaveLength(3);

      // Newest-first, capped at maxItems=2. Re-viewed alpha is newest, gamma was the prior newest.
      const recent = await call({ method: 'GET', path: '/recent', customer: cust });
      expect(recent.status).toBe(200);
      expect(idsOf(recent)).toEqual([productIds[0], productIds[2]]);

      // Enrichment populated via the real read:products adapter.
      const items = (JSON.parse(recent.body!) as { items: Array<{ product: unknown }> }).items;
      expect(items[0]!.product).toMatchObject({ slug: 'rv-alpha' });
    } finally {
      env.dispose();
    }
  });

  it('per-viewer isolation: a second customer sees only their own history', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env);
      const a = { id: 'cust-' + newId() };
      const b = { id: 'cust-' + newId() };
      await call({
        method: 'POST',
        path: '/views',
        customer: a,
        body: JSON.stringify({ productId: productIds[0] }),
      });
      await call({
        method: 'POST',
        path: '/views',
        customer: b,
        body: JSON.stringify({ productId: productIds[1] }),
      });

      expect(idsOf(await call({ method: 'GET', path: '/recent', customer: a }))).toEqual([
        productIds[0],
      ]);
      expect(idsOf(await call({ method: 'GET', path: '/recent', customer: b }))).toEqual([
        productIds[1],
      ]);
    } finally {
      env.dispose();
    }
  });

  it('a guest (opaque token) is isolated from a customer and from another guest', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env);
      const cust = { id: 'cust-' + newId() };
      const guestB = GUEST_TOKEN + '-b';

      await call({
        method: 'POST',
        path: '/views',
        customer: cust,
        body: JSON.stringify({ productId: productIds[0] }),
      });
      await call({
        method: 'POST',
        path: '/views',
        query: { guest: GUEST_TOKEN },
        body: JSON.stringify({ productId: productIds[1] }),
      });
      await call({
        method: 'POST',
        path: '/views',
        query: { guest: guestB },
        body: JSON.stringify({ productId: productIds[2] }),
      });

      // The guest only sees their own token-scoped view.
      expect(
        idsOf(await call({ method: 'GET', path: '/recent', query: { guest: GUEST_TOKEN } })),
      ).toEqual([productIds[1]]);
      // The customer never sees the guest's views.
      expect(idsOf(await call({ method: 'GET', path: '/recent', customer: cust }))).toEqual([
        productIds[0],
      ]);
    } finally {
      env.dispose();
    }
  });

  it('namespace collision guard: (a) a verified customer wins over a simultaneous guest token, and (b) a guest supplying a string EQUAL to a customer id cannot read that customer history', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env);
      const cust = { id: 'cust-' + newId() };
      // The attacker's guest token is EXACTLY the victim customer's id (>= 16 chars → length-OK).
      const collidingToken = cust.id;
      expect(collidingToken.length).toBeGreaterThanOrEqual(16);

      // (a) The customer views a product while ALSO carrying the colliding guest token. The verified
      // customer must win → the view is stored under the customer key, not the guest key.
      const post = await call({
        method: 'POST',
        path: '/views',
        customer: cust,
        query: { guest: collidingToken },
        body: JSON.stringify({ productId: productIds[0] }),
      });
      expect(post.status).toBe(204);

      // (b) A pure guest (no customer) presents that SAME string as their token and reads. Because the
      // stored key is `cust:<id>` and the guest resolves to `guest:<id>`, the namespaced keys differ →
      // the guest sees NOTHING of the customer's history.
      const guestView = await call({
        method: 'GET',
        path: '/recent',
        query: { guest: collidingToken },
      });
      expect(guestView.status).toBe(200);
      expect(idsOf(guestView)).toEqual([]);

      // The customer themself still sees their view (sanity: the row really was stored).
      expect(idsOf(await call({ method: 'GET', path: '/recent', customer: cust }))).toEqual([
        productIds[0],
      ]);

      // And at the row level the stored viewer_key is the cust:-namespaced one, never the bare id.
      const stored = await executor.exec(MOD, `SELECT viewer_key FROM ${TABLE}`);
      expect(stored.rows).toHaveLength(1);
      expect((stored.rows[0] as { viewer_key: string }).viewer_key).toBe(`cust:${cust.id}`);
    } finally {
      env.dispose();
    }
  });

  it('excludeCategories filters out a view END-TO-END (default resolver reads ModuleProductDto.category)', async () => {
    const env = wire(ALL_GRANTS);
    try {
      // No injected resolver → the module's default storeProductCategoryResolver resolves each
      // product's primary category from the REAL read:products DTO. beta (productIds[1]) is linked to
      // the hidden category in the DB, so excluding that category id drops it.
      const call = serve(env, {
        settingsBag: { enabled: true, excludeCategories: [hiddenCategoryId] },
        categoryResolver: storeProductCategoryResolver(env.sdk.store.products),
      });
      const cust = { id: 'cust-' + newId() };
      for (const pid of productIds) {
        await call({
          method: 'POST',
          path: '/views',
          customer: cust,
          body: JSON.stringify({ productId: pid }),
        });
      }
      const recent = await call({ method: 'GET', path: '/recent', customer: cust });
      // gamma (newest) + alpha survive; beta (hidden category) is filtered out.
      expect(idsOf(recent)).toEqual([productIds[2], productIds[0]]);
    } finally {
      env.dispose();
    }
  });

  it('excludeCategories still honours an INJECTED resolver seam (stays stubbable)', async () => {
    const env = wire(ALL_GRANTS);
    try {
      // productIds[1] is in the hidden category; the others are not.
      const resolver: ProductCategoryResolver = {
        categoriesOf: (id) => Promise.resolve(new Set(id === productIds[1] ? ['cat-hidden'] : [])),
      };
      const call = serve(env, {
        settingsBag: { enabled: true, excludeCategories: ['cat-hidden'] },
        categoryResolver: resolver,
      });
      const cust = { id: 'cust-' + newId() };
      for (const pid of productIds) {
        await call({
          method: 'POST',
          path: '/views',
          customer: cust,
          body: JSON.stringify({ productId: pid }),
        });
      }
      const recent = await call({ method: 'GET', path: '/recent', customer: cust });
      // gamma (newest) + alpha survive; beta (hidden category) is filtered out.
      expect(idsOf(recent)).toEqual([productIds[2], productIds[0]]);
    } finally {
      env.dispose();
    }
  });

  it('?exclude drops the current product from the rail', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env);
      const cust = { id: 'cust-' + newId() };
      for (const pid of productIds) {
        await call({
          method: 'POST',
          path: '/views',
          customer: cust,
          body: JSON.stringify({ productId: pid }),
        });
      }
      const recent = await call({
        method: 'GET',
        path: '/recent',
        customer: cust,
        query: { exclude: productIds[2] },
      });
      expect(idsOf(recent)).not.toContain(productIds[2]);
      expect(idsOf(recent)).toEqual([productIds[1], productIds[0]]);
    } finally {
      env.dispose();
    }
  });

  it('anonymous POST (no customer, no token) → 401; GET → 200 empty', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env);
      const post = await call({
        method: 'POST',
        path: '/views',
        body: JSON.stringify({ productId: productIds[0] }),
      });
      expect(post.status).toBe(401);
      const get = await call({ method: 'GET', path: '/recent' });
      expect(get.status).toBe(200);
      expect(idsOf(get)).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it('verifyProductExists on + unknown product → 404 (read:products driven end-to-end)', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env, { verifyProductExists: true });
      const res = await call({
        method: 'POST',
        path: '/views',
        customer: { id: 'cust-' + newId() },
        body: JSON.stringify({ productId: newId() }),
      });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body!)).toEqual({ error: 'product_not_found' });
      const rows = await executor.exec(MOD, `SELECT id FROM ${TABLE}`);
      expect(rows.rows).toHaveLength(0);
    } finally {
      env.dispose();
    }
  });

  it('migration created mod_recently-viewed schema + table', async () => {
    const res = await executor.exec(
      MOD,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [`mod_${MOD}`],
    );
    const names = res.rows.map((r) => String((r as { table_name: string }).table_name));
    expect(names).toEqual(expect.arrayContaining(['mod_recently-viewed_views']));
  });

  it('without write:own_tables the module cannot record a view (insert is FORBIDDEN)', async () => {
    const env = wire(['read:products'] as ModulePermission[]);
    try {
      const call = serve(env);
      const res = call({
        method: 'POST',
        path: '/views',
        customer: { id: 'cust-' + newId() },
        body: JSON.stringify({ productId: productIds[0] }),
      });
      await expect(res).rejects.toThrow(/write:own_tables/);
    } finally {
      env.dispose();
    }
  });
});
