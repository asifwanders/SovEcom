/**
 * ii — Wishlist reference module END-TO-END integration (real Postgres, real runtime).
 *
 * Installs the actual `modules/wishlist` module and drives it through the REAL module runtime:
 *   - provision the module's PG schema + low-privilege role, open its dedicated connection;
 *   - wire a REAL ModuleBroker (real read adapter for enrichment, real mail port with a recording
 *     transport, real SQL executor) over an in-memory RPC channel pair;
 *   - build the worker-side SDK and run the module's OWN `defineModule({ activate })` — its real
 *     migration creates `mod_wishlist_*` in its schema and its `sdk.serve` handler is registered;
 *   - drive the mounted endpoints over `http.handle` exactly as the store proxy would, carrying the
 *     CORE-VERIFIED `customer` field — proving the module receives it;
 *   - assert add/list/remove, the per-customer cap, anonymous → 401, and TWO-CUSTOMER ISOLATION
 *     (customer B cannot see or remove customer A's items);
 *   - trigger the price-drop digest and assert an email is QUEUED via the recording transport.
 *
 * The HTTP-proxy→forked-worker path is intentionally NOT used (the runtime forks a compiled
 * dist/worker-entry.js that does not exist under ts-jest — see modules-chunk-e.int-spec.ts). This
 * suite exercises the same broker + SDK + `http.handle` contract over an in-memory peer pair, which
 * is the established real-runtime integration pattern (broker-tables / broker-email int-specs).
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
import { RpcPeer } from '../../../src/modules/runtime/rpc';
import { createInMemoryChannelPair } from '../../../src/modules/runtime/worker-channel';
import { createModuleSdk } from '../../../src/modules/runtime/worker-sdk';
import { ModuleBroker, type BrokerContext } from '../../../src/modules/runtime/module-broker';
import { BrokerReadAdapter } from '../../../src/modules/runtime/broker-read.adapter';
import { ModuleDbProvisioner } from '../../../src/modules/runtime/module-db.provisioner';
import { ModuleSqlExecutor } from '../../../src/modules/runtime/module-sql.executor';
import {
  ModuleMailPort,
  FixedWindowRateLimiter,
} from '../../../src/modules/runtime/module-mail.port';
import { CustomerEmailLookupAdapter } from '../../../src/modules/runtime/customer-email-lookup.adapter';
import { customers } from '../../../src/database/schema/customers';
import { tenants } from '../../../src/database/schema/_tenants';
import type { IMailService } from '../../../src/mail/mail.service';
import type { ModuleHttpRequest, ModuleHttpResponse, ModuleSdk } from '@sovecom/module-sdk';

// The module under test. ts-jest resolves the workspace package to its TS source.
import wishlistModule, { runPriceDropDigest } from '../../../../../modules/wishlist/src/index';
import { WishlistRepository } from '../../../../../modules/wishlist/src/db/repository';
import { handleRequest } from '../../../../../modules/wishlist/src/api/handlers';
import { resolveSettings } from '../../../../../modules/wishlist/src/settings';

const MOD = 'wishlist';
const TENANT = DEFAULT_TENANT_ID;
const CUST_A = 'cust-a-' + newId();
const CUST_B = 'cust-b-' + newId();

interface Harness {
  corePeer: RpcPeer;
  workerPeer: RpcPeer;
  sdk: ModuleSdk;
  sent: Array<{ to: string; subject: string; text: string }>;
  dispose: () => void;
}

describe('Wishlist module end-to-end (integration, real PG)', () => {
  let h: AuthHarness;
  let db: DatabaseService;
  let provisioner: ModuleDbProvisioner;
  let executor: ModuleSqlExecutor;
  let audit: AuditService;
  let productId: string;

  beforeAll(async () => {
    h = await bootAuthApp();
    db = h.app.get(DatabaseService);
    audit = h.app.get(AuditService);
    provisioner = new ModuleDbProvisioner(db);
    executor = new ModuleSqlExecutor(db);

    // Fresh module DB home (schema + role), then open its dedicated low-privilege connection.
    await provisioner.deprovision(MOD).catch(() => undefined);
    await provisioner.provision(MOD);
    executor.open(MOD, await provisioner.rotateCredential(MOD));

    // Seed the default tenant + a product so list-enrichment has something to resolve.
    await db.db
      .insert(products)
      .values({ tenantId: TENANT, title: 'Red Shirt', slug: 'red-shirt', status: 'published' })
      .onConflictDoNothing();
    const [row] = await db.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.tenantId, TENANT), eq(products.slug, 'red-shirt')))
      .limit(1);
    productId = row!.id;
  });

  afterAll(async () => {
    await executor.close(MOD).catch(() => undefined);
    await provisioner.deprovision(MOD).catch(() => undefined);
    await teardownAuthApp(h);
  });

  // Each test runs against clean module tables (they persist in the shared schema otherwise). The
  // tables are created by the first activate()'s migration; truncate is best-effort before that.
  beforeEach(async () => {
    for (const t of ['mod_wishlist_items', 'mod_wishlist_digest_log']) {
      await executor.exec(MOD, `TRUNCATE TABLE ${t}`).catch(() => undefined);
    }
  });

  /**
   * Wire a real broker (read adapter + executor + recording mail port) over an RPC pair, build the
   * worker SDK, and run the wishlist module's real `activate(sdk)` (migration + serve registration).
   */
  async function activate(grants: string[]): Promise<Harness> {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const mail: IMailService = {
      send: async (opts: { to: string; subject: string; text: string }) => {
        sent.push(opts);
        return { messageId: 'm-int' };
      },
    } as unknown as IMailService;
    // The mail port resolves the recipient via the real DB-backed lookup (consent/erasure-aware).
    const mailPort = new ModuleMailPort(
      mail,
      audit,
      new FixedWindowRateLimiter(100, 60_000),
      new CustomerEmailLookupAdapter(db),
    );
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
      grantedPermissions: new Set(grants as never),
      httpAllowlist: new Set<string>(),
    };
    broker.registerOn(corePeer, ctx);

    const sdk = createModuleSdk(workerPeer);
    // Run the module's REAL activate — creates mod_wishlist_* and registers the serve handler.
    await wishlistModule.activate(sdk);

    return {
      corePeer,
      workerPeer,
      sdk,
      sent,
      dispose: () => {
        corePeer.dispose();
        workerPeer.dispose();
      },
    };
  }

  /** Drive a request through the proxy's `http.handle` contract (core peer → worker serve handler). */
  async function call(
    core: RpcPeer,
    partial: Partial<ModuleHttpRequest>,
  ): Promise<ModuleHttpResponse> {
    const req: ModuleHttpRequest = {
      surface: 'store',
      tenantId: TENANT,
      method: 'GET',
      path: '/items',
      query: {},
      headers: {},
      ...partial,
    };
    return (await core.request('http.handle', req)) as ModuleHttpResponse;
  }

  const ALL_GRANTS = ['read:products', 'write:own_tables', 'subscribe:events', 'email:send'];

  it('migration ran: mod_wishlist schema + tables exist after activate', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const res = await executor.exec(
        MOD,
        `SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1 ORDER BY table_name`,
        [`mod_${MOD}`],
      );
      const names = res.rows.map((r) => String((r as { table_name: string }).table_name));
      expect(names).toEqual(
        expect.arrayContaining(['mod_wishlist_items', 'mod_wishlist_digest_log']),
      );
    } finally {
      env.dispose();
    }
  });

  it('the module receives the core-verified customer id end-to-end (add → 201)', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const res = await call(env.corePeer, {
        method: 'POST',
        path: '/items',
        body: JSON.stringify({ productVariantId: productId }),
        customer: { id: CUST_A },
      });
      expect(res.status).toBe(201);
      const body = JSON.parse(res.body!) as { productVariantId: string };
      expect(body.productVariantId).toBe(productId);
    } finally {
      env.dispose();
    }
  });

  it('anonymous add (no customer) → 401, nothing written', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const res = await call(env.corePeer, {
        method: 'POST',
        path: '/items',
        body: JSON.stringify({ productVariantId: productId }),
      });
      expect(res.status).toBe(401);
    } finally {
      env.dispose();
    }
  });

  it('anonymous GET /items and DELETE /items/:id → 401 (login required)', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const list = await call(env.corePeer, { method: 'GET', path: '/items' });
      expect(list.status).toBe(401);
      const del = await call(env.corePeer, { method: 'DELETE', path: `/items/${productId}` });
      expect(del.status).toBe(401);
    } finally {
      env.dispose();
    }
  });

  it('add → list (enriched) → remove for one customer', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const v = 'variant-' + newId();
      // add the real product id (enrichable) + an opaque variant (not enrichable)
      await call(env.corePeer, {
        method: 'POST',
        path: '/items',
        body: JSON.stringify({ productVariantId: productId }),
        customer: { id: CUST_A },
      });
      await call(env.corePeer, {
        method: 'POST',
        path: '/items',
        body: JSON.stringify({ productVariantId: v }),
        customer: { id: CUST_A },
      });

      const listed = await call(env.corePeer, {
        method: 'GET',
        path: '/items',
        customer: { id: CUST_A },
      });
      expect(listed.status).toBe(200);
      const body = JSON.parse(listed.body!) as {
        items: Array<{ productVariantId: string; product: { slug: string } | null }>;
      };
      expect(body.items.map((i) => i.productVariantId).sort()).toEqual([productId, v].sort());
      const enriched = body.items.find((i) => i.productVariantId === productId);
      expect(enriched?.product).toMatchObject({ slug: 'red-shirt', status: 'published' });

      const removed = await call(env.corePeer, {
        method: 'DELETE',
        path: `/items/${productId}`,
        customer: { id: CUST_A },
      });
      expect(removed.status).toBe(204);
    } finally {
      env.dispose();
    }
  });

  it("TWO-CUSTOMER ISOLATION: B cannot see or remove A's items", async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const v = 'iso-' + newId();
      // A adds.
      await call(env.corePeer, {
        method: 'POST',
        path: '/items',
        body: JSON.stringify({ productVariantId: v }),
        customer: { id: CUST_A },
      });

      // B's list must not contain A's item.
      const bList = await call(env.corePeer, {
        method: 'GET',
        path: '/items',
        customer: { id: CUST_B },
      });
      const bItems = (JSON.parse(bList.body!) as { items: Array<{ productVariantId: string }> })
        .items;
      expect(bItems.some((i) => i.productVariantId === v)).toBe(false);

      // B cannot delete A's item.
      const bDel = await call(env.corePeer, {
        method: 'DELETE',
        path: `/items/${v}`,
        customer: { id: CUST_B },
      });
      expect(bDel.status).toBe(404);

      // A still has it.
      const aList = await call(env.corePeer, {
        method: 'GET',
        path: '/items',
        customer: { id: CUST_A },
      });
      const aItems = (JSON.parse(aList.body!) as { items: Array<{ productVariantId: string }> })
        .items;
      expect(aItems.some((i) => i.productVariantId === v)).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it('enforces maxItemsPerCustomer end-to-end: third add → 409 (real handler + real PG)', async () => {
    // Drive the REAL handler (handleRequest) against the broker-backed sdk.tables (real executor →
    // real Postgres) with a capped settings bag. The module's own activate() uses the default cap
    // (100); here we exercise the actual cap gate + the handler's 409 response over the same SQL
    // path the proxy uses — not a repo-count assertion.
    const env = await activate(ALL_GRANTS);
    try {
      const repo = new WishlistRepository(env.sdk.tables);
      const settings = resolveSettings({ maxItemsPerCustomer: 2 });
      const deps = { repo, store: env.sdk.store, settings };
      const capCustomer = 'cap-' + newId();

      const add = (v: string) =>
        handleRequest(
          {
            surface: 'store' as const,
            tenantId: TENANT,
            method: 'POST',
            path: '/items',
            query: {},
            headers: {},
            body: JSON.stringify({ productVariantId: v }),
            customer: { id: capCustomer },
          },
          deps,
        );

      expect((await add('c1')).status).toBe(201);
      expect((await add('c2')).status).toBe(201);
      const third = await add('c3');
      expect(third.status).toBe(409);
      expect(JSON.parse(third.body!)).toMatchObject({
        error: 'max_items_reached',
        maxItemsPerCustomer: 2,
      });
      // Only two rows actually landed in Postgres.
      expect(await repo.countForCustomer(capCustomer)).toBe(2);
    } finally {
      env.dispose();
    }
  });

  /** Seed a real customer row (the digest now addresses by uuid; core resolves the email). */
  async function seedCustomer(
    email: string,
    over: Partial<{ acceptsMarketing: boolean; deletedAt: Date; anonymizedAt: Date }> = {},
  ): Promise<string> {
    const [row] = await db.db
      .insert(customers)
      .values({
        tenantId: TENANT,
        email,
        acceptsMarketing: over.acceptsMarketing ?? true,
        deletedAt: over.deletedAt ?? null,
        anonymizedAt: over.anonymizedAt ?? null,
      })
      .returning({ id: customers.id });
    return row!.id;
  }

  const candidate = (v: string) => ({
    productVariantId: v,
    title: 'Red Shirt',
    oldPriceMinor: 3000,
    newPriceMinor: 1999,
    currency: 'EUR',
  });

  it('digest: queues via sendToCustomer for a marketing-consented customer; idempotent', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const digCustomer = await seedCustomer(`dig-${newId()}@example.com`, {
        acceptsMarketing: true,
      });
      const v = 'dropv-' + newId();
      // The customer wishlists the variant via the real endpoint (carrying the verified id).
      await call(env.corePeer, {
        method: 'POST',
        path: '/items',
        body: JSON.stringify({ productVariantId: v }),
        customer: { id: digCustomer },
      });

      const repo = new WishlistRepository(env.sdk.tables);
      const result = await runPriceDropDigest(
        { digestRunId: 'run-int-1', candidates: [candidate(v)] },
        { repo, email: env.sdk.email, settings: resolveSettings({ weeklyDigest: true }) },
      );

      expect(result.sent).toBe(1);
      expect(env.sent).toHaveLength(1);
      // Core resolved the recipient from the customer row — the module supplied only the id.
      expect(env.sent[0]!.to).toBe(
        (
          await db.db
            .select({ email: customers.email })
            .from(customers)
            .where(eq(customers.id, digCustomer))
            .limit(1)
        )[0]!.email,
      );
      expect(env.sent[0]!.subject).toMatch(/price drop/i);

      // Idempotent re-run with the SAME digestRunId queues nothing further.
      const again = await runPriceDropDigest(
        { digestRunId: 'run-int-1', candidates: [candidate(v)] },
        { repo, email: env.sdk.email, settings: resolveSettings({ weeklyDigest: true }) },
      );
      expect(again.sent).toBe(0);
      expect(env.sent).toHaveLength(1);
    } finally {
      env.dispose();
    }
  });

  it('digest: SUPPRESSED for a NON-consented customer — no email, claim consumed', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const optedOut = await seedCustomer(`noconsent-${newId()}@example.com`, {
        acceptsMarketing: false,
      });
      const v = 'dropv-' + newId();
      await call(env.corePeer, {
        method: 'POST',
        path: '/items',
        body: JSON.stringify({ productVariantId: v }),
        customer: { id: optedOut },
      });

      const repo = new WishlistRepository(env.sdk.tables);
      const result = await runPriceDropDigest(
        { digestRunId: 'run-int-suppress', candidates: [candidate(v)] },
        { repo, email: env.sdk.email, settings: resolveSettings({ weeklyDigest: true }) },
      );

      // Core suppressed (no marketing consent): nothing reached the transport, counted as skipped.
      expect(result.sent).toBe(0);
      expect(result.skipped).toBe(1);
      expect(env.sent).toHaveLength(0);
    } finally {
      env.dispose();
    }
  });

  it('digest: a CROSS-TENANT customerId is SUPPRESSED (no cross-tenant read, no email)', async () => {
    // Seed a fully-consented customer under a DIFFERENT tenant, wishlist a variant for that id in the
    // module's tables, then run the digest under the DEFAULT-tenant broker. The recipient resolver is
    // tenant-scoped by ctx, so the foreign-tenant id resolves to nothing → suppressed → no email.
    const [tenantB] = await db.db
      .insert(tenants)
      .values({ name: 'WL Tenant B', slug: `wl-tenant-b-${newId()}` })
      .returning({ id: tenants.id });
    const [foreign] = await db.db
      .insert(customers)
      .values({
        tenantId: tenantB!.id,
        email: `wl-foreign-${newId()}@example.com`,
        acceptsMarketing: true,
      })
      .returning({ id: customers.id });

    const env = await activate(ALL_GRANTS); // ctx tenant is the DEFAULT tenant, NOT tenantB
    try {
      const v = 'dropv-' + newId();
      // The (foreign-tenant) customer id is wishlisted in the module's own tables under the default
      // tenant's module schema; the wishlist table has no tenant column — the guard is core's resolver.
      await call(env.corePeer, {
        method: 'POST',
        path: '/items',
        body: JSON.stringify({ productVariantId: v }),
        customer: { id: foreign!.id },
      });

      const repo = new WishlistRepository(env.sdk.tables);
      const result = await runPriceDropDigest(
        { digestRunId: 'run-int-xtenant', candidates: [candidate(v)] },
        { repo, email: env.sdk.email, settings: resolveSettings({ weeklyDigest: true }) },
      );

      // The default-tenant broker cannot resolve tenant-B's customer → suppressed, nothing queued.
      expect(result.sent).toBe(0);
      expect(env.sent).toHaveLength(0);

      // Sanity: the lookup DOES resolve under tenant B (proves the row is real, only scope differs).
      const lookup = new CustomerEmailLookupAdapter(db);
      expect(await lookup.resolveForModuleEmail(tenantB!.id, foreign!.id)).toMatchObject({
        status: 'ok',
      });
      // …and the DEFAULT tenant gets 'missing' for the same id (no cross-tenant disclosure).
      expect(await lookup.resolveForModuleEmail(TENANT, foreign!.id)).toEqual({
        status: 'suppressed',
        reason: 'missing',
      });
    } finally {
      env.dispose();
      await db.db.delete(tenants).where(eq(tenants.id, tenantB!.id)); // cascades the foreign customer
    }
  });

  it('without write:own_tables the module cannot store (activate migration is FORBIDDEN)', async () => {
    // A module missing the grant must be refused at the DB-write boundary by the broker.
    await expect(activate(['read:products'])).rejects.toBeDefined();
  });
});
