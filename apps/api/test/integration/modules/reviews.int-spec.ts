/**
 * i — Reviews reference module END-TO-END integration (real Postgres, real runtime).
 * Mirrors wishlist.int-spec.ts / notify-back-in-stock.int-spec.ts.
 *
 * Installs the actual `modules/reviews` module and drives it through the REAL module runtime:
 *   - provision the module's PG schema + low-privilege role, open its dedicated connection;
 *   - wire a REAL ModuleBroker (real read adapter for product existence + orders, real SQL executor)
 *     over an in-memory RPC channel pair;
 *   - build the worker-side SDK and run the module's OWN migration so `mod_reviews_reviews` is
 *     created in its schema; mount the handler with the same deps the module's activate() wires,
 *     but with an INJECTED purchase verifier (see the PURCHASE-GATE note below);
 *   - drive the mounted endpoint over `http.handle` exactly as the proxy would.
 *
 * PURCHASE-GATE: the gated `read:orders` surface now exposes a boolean-only
 * `sdk.commerce.hasPurchased(customerId, productId)` probe. A (customer, product) purchase is
 * verifiable end-to-end through the real BrokerReadAdapter: this suite seeds a REAL paid order
 * (with a line item whose variant maps to the seeded product) for a "buyer" customer, and proves
 * purchaser → pending vs non-purchaser → 403 with the module's DEFAULT (commerce-backed)
 * verifier. The product-existence guard (read:products) is likewise driven end-to-end.
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
import { tenants } from '../../../src/database/schema/_tenants';
import { productVariants } from '../../../src/database/schema/product_variants';
import { orders } from '../../../src/database/schema/orders';
import { orderItems } from '../../../src/database/schema/order_items';
import { customers } from '../../../src/database/schema/customers';
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
import { MIGRATION_STATEMENTS } from '../../../../../modules/reviews/src/db/schema';
import { ReviewsRepository } from '../../../../../modules/reviews/src/db/repository';
import { handleRequest } from '../../../../../modules/reviews/src/api/handlers';
import { resolveSettings } from '../../../../../modules/reviews/src/settings';
import type { PurchaseVerifier } from '../../../../../modules/reviews/src/purchase/purchase-gate';

const MOD = 'reviews';
const TENANT = DEFAULT_TENANT_ID;
const TABLE = 'mod_reviews_reviews';

// A stub verifier used ONLY by the auth/validation tests where the purchase is irrelevant. The
// purchaser/non-purchaser tests use the module's DEFAULT (commerce-backed) verifier against real
// seeded orders — see the BUYER/NON-BUYER customers below.
const STUB_ALLOW: PurchaseVerifier = { verify: () => Promise.resolve(true) };

interface Harness {
  corePeer: RpcPeer;
  workerPeer: RpcPeer;
  sdk: ModuleSdk;
  dispose: () => void;
}

describe('Reviews module end-to-end (integration, real PG)', () => {
  let h: AuthHarness;
  let db: DatabaseService;
  let provisioner: ModuleDbProvisioner;
  let executor: ModuleSqlExecutor;
  let audit: AuditService;
  let productId: string;
  let buyerId: string; // a customer with a real paid order containing the product
  let nonBuyerId: string; // a customer who bought nothing

  beforeAll(async () => {
    h = await bootAuthApp();
    db = h.app.get(DatabaseService);
    audit = h.app.get(AuditService);
    provisioner = new ModuleDbProvisioner(db);
    executor = new ModuleSqlExecutor(db);

    await provisioner.deprovision(MOD).catch(() => undefined);
    await provisioner.provision(MOD);
    executor.open(MOD, await provisioner.rotateCredential(MOD));

    // Seed the default tenant (FK parent) first — mirrors the other module specs so this
    // suite is order-independent (it previously relied on another suite seeding the tenant).
    await db.db
      .insert(tenants)
      .values({ id: TENANT, name: 'Default', slug: 'default' })
      .onConflictDoNothing();
    // Seed a product so the read:products existence guard resolves it through the real read adapter.
    await db.db
      .insert(products)
      .values({
        tenantId: TENANT,
        title: 'Reviewable Widget',
        slug: 'reviewable-widget',
        status: 'published',
      })
      .onConflictDoNothing();
    const [row] = await db.db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.tenantId, TENANT), eq(products.slug, 'reviewable-widget')))
      .limit(1);
    productId = row!.id;

    // A variant of the product so an order line can map back to it (purchase probe).
    const [variant] = await db.db
      .insert(productVariants)
      .values({
        tenantId: TENANT,
        productId,
        sku: `rev-var-${newId()}`,
        options: {},
        priceAmount: 1000,
        currency: 'EUR',
      })
      .returning({ id: productVariants.id });

    // Two customers: a buyer (real paid order containing the variant) and a non-buyer.
    [buyerId, nonBuyerId] = await Promise.all(
      ['rev-buyer', 'rev-nonbuyer'].map(async (tag) => {
        const [c] = await db.db
          .insert(customers)
          .values({ tenantId: TENANT, email: `${tag}-${newId()}@example.com` })
          .returning({ id: customers.id });
        return c!.id;
      }),
    );

    const [order] = await db.db
      .insert(orders)
      .values({
        tenantId: TENANT,
        orderNumber: `REV-${newId()}`,
        customerId: buyerId,
        email: 'rev-buyer@example.com',
        status: 'paid',
        currency: 'EUR',
        subtotalAmount: 1000,
        totalAmount: 1000,
        taxInclusive: true,
        shippingAddress: {},
        billingAddress: {},
      })
      .returning({ id: orders.id });
    await db.db.insert(orderItems).values({
      tenantId: TENANT,
      orderId: order!.id,
      variantId: variant!.id,
      productTitle: 'Reviewable Widget',
      sku: `rev-line-${newId()}`,
      quantity: 1,
      unitPriceAmount: 1000,
      taxRate: '0.2000',
      taxAmount: 0,
      lineTotalAmount: 1000,
    });

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

  const ALL_GRANTS: ModulePermission[] = ['read:products', 'write:own_tables', 'read:orders'];

  /**
   * Mount the reviews handler with the module's deps and return a request driver. When `verifier`
   * is omitted the module's DEFAULT (commerce-backed, real `sdk.commerce.hasPurchased`) verdict runs
   * end-to-end against the seeded orders; pass a stub only where the purchase is irrelevant.
   */
  function serve(
    env: Harness,
    verifier?: PurchaseVerifier,
    settingsBag: unknown = { enabled: true },
  ): (partial: Partial<ModuleHttpRequest>) => Promise<ModuleHttpResponse> {
    const repo = new ReviewsRepository(env.sdk.tables);
    const deps = {
      repo,
      products: env.sdk.store.products,
      commerce: env.sdk.commerce,
      settings: resolveSettings(settingsBag),
      ...(verifier ? { purchaseVerifier: verifier } : {}),
    };
    env.sdk.serve((req) => handleRequest(req, deps));
    return (partial: Partial<ModuleHttpRequest>) => {
      const req: ModuleHttpRequest = {
        surface: 'store',
        tenantId: TENANT,
        method: 'GET',
        path: '/reviews',
        query: {},
        headers: {},
        ...partial,
      };
      return env.corePeer.request('http.handle', req) as Promise<ModuleHttpResponse>;
    };
  }

  it('REAL purchaser → 201 pending (default commerce verifier, real paid order)', async () => {
    const env = wire(ALL_GRANTS);
    try {
      // No stub verifier → the module's default sdk.commerce.hasPurchased probe runs end-to-end. The
      // buyer has a seeded paid order containing the product, so it returns true.
      const call = serve(env);
      const res = await call({
        method: 'POST',
        path: '/reviews',
        customer: { id: buyerId },
        body: JSON.stringify({
          productId,
          rating: 5,
          body: 'Genuinely great, bought and loved it.',
        }),
      });
      expect(res.status).toBe(201);
      expect((JSON.parse(res.body!) as { status: string }).status).toBe('pending');

      const rows = await executor.exec(
        MOD,
        `SELECT status, rating FROM ${TABLE} WHERE product_id = $1 AND customer_id = $2`,
        [productId, buyerId],
      );
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as { status: string }).status).toBe('pending');
    } finally {
      env.dispose();
    }
  });

  it('REAL non-purchaser → 403 not_purchased (default commerce verifier; nothing stored)', async () => {
    const env = wire(ALL_GRANTS);
    try {
      // The non-buyer has NO order → the real commerce probe returns false → 403.
      const call = serve(env);
      const res = await call({
        method: 'POST',
        path: '/reviews',
        customer: { id: nonBuyerId },
        body: JSON.stringify({ productId, rating: 4, body: 'I did not actually buy this.' }),
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body!)).toEqual({ error: 'not_purchased' });
      const rows = await executor.exec(MOD, `SELECT id FROM ${TABLE} WHERE customer_id = $1`, [
        nonBuyerId,
      ]);
      expect(rows.rows).toHaveLength(0);
    } finally {
      env.dispose();
    }
  });

  it('without read:orders the purchase probe is FORBIDDEN → submit cannot pass the gate', async () => {
    // Drop read:orders: the default commerce verifier's hasPurchased call is refused by the broker;
    // the verifier degrades that to DENY → 403 (the gate fails closed without the grant).
    const env = wire(['read:products', 'write:own_tables'] as ModulePermission[]);
    try {
      const call = serve(env);
      const res = await call({
        method: 'POST',
        path: '/reviews',
        customer: { id: buyerId },
        body: JSON.stringify({ productId, rating: 5, body: 'Buyer but no read:orders grant.' }),
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body!)).toEqual({ error: 'not_purchased' });
    } finally {
      env.dispose();
    }
  });

  it('anonymous submit → 401 login_required', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env, STUB_ALLOW);
      const res = await call({
        method: 'POST',
        path: '/reviews',
        body: JSON.stringify({ productId, rating: 5, body: 'Anonymous attempt body.' }),
      });
      expect(res.status).toBe(401);
    } finally {
      env.dispose();
    }
  });

  it('unknown product → 404 product_not_found (read:products driven end-to-end)', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env, STUB_ALLOW);
      const res = await call({
        method: 'POST',
        path: '/reviews',
        customer: { id: 'cust-' + newId() },
        body: JSON.stringify({
          productId: newId(),
          rating: 5,
          body: 'Reviewing a ghost product id.',
        }),
      });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body!)).toEqual({ error: 'product_not_found' });
    } finally {
      env.dispose();
    }
  });

  it('duplicate review by same customer for same product → 409 already_reviewed', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env, STUB_ALLOW);
      const cust = { id: 'cust-' + newId() };
      const payload = JSON.stringify({
        productId,
        rating: 3,
        body: 'My one and only review here.',
      });
      expect(
        (await call({ method: 'POST', path: '/reviews', customer: cust, body: payload })).status,
      ).toBe(201);
      const dup = await call({ method: 'POST', path: '/reviews', customer: cust, body: payload });
      expect(dup.status).toBe(409);
      expect(JSON.parse(dup.body!)).toEqual({ error: 'already_reviewed' });
    } finally {
      env.dispose();
    }
  });

  it('moderation: admin approve makes a pending review public + updates the average; reject excludes it', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env, STUB_ALLOW);

      // Two purchasers each leave a pending review.
      const created: string[] = [];
      for (const [rating, text] of [
        [4, 'Four star, solid buy.'],
        [2, 'Two star, meh purchase.'],
      ] as const) {
        const res = await call({
          method: 'POST',
          path: '/reviews',
          customer: { id: 'cust-' + newId() },
          body: JSON.stringify({ productId, rating, body: text }),
        });
        expect(res.status).toBe(201);
        created.push((JSON.parse(res.body!) as { id: string }).id);
      }

      // Public read: nothing approved yet.
      let pub = await call({ method: 'GET', path: '/reviews', query: { productId } });
      expect(JSON.parse(pub.body!)).toMatchObject({ count: 0, average: null });

      // Admin approves both (admin surface).
      for (const id of created) {
        const res = await call({ surface: 'admin', method: 'POST', path: `/${id}/approve` });
        expect(res.status).toBe(204);
      }

      // Now both are public; average is the approved-only mean (4 + 2) / 2 = 3.
      pub = await call({ method: 'GET', path: '/reviews', query: { productId } });
      const summary = JSON.parse(pub.body!) as {
        count: number;
        average: number;
        reviews: unknown[];
      };
      expect(summary.count).toBe(2);
      expect(summary.average).toBe(3);
      expect(summary.reviews).toHaveLength(2);

      // Reject one → it drops out + the average recomputes to the remaining (4).
      const rej = await call({ surface: 'admin', method: 'POST', path: `/${created[1]!}/reject` });
      expect(rej.status).toBe(204);
      pub = await call({ method: 'GET', path: '/reviews', query: { productId } });
      expect(JSON.parse(pub.body!)).toMatchObject({ count: 1, average: 4 });
    } finally {
      env.dispose();
    }
  });

  it('admin queue lists pending reviews; admin paths are 404 on the store surface', async () => {
    const env = wire(ALL_GRANTS);
    try {
      const call = serve(env, STUB_ALLOW);
      await call({
        method: 'POST',
        path: '/reviews',
        customer: { id: 'cust-' + newId() },
        body: JSON.stringify({ productId, rating: 5, body: 'Awaiting moderation body.' }),
      });

      const queue = await call({ surface: 'admin', method: 'GET', path: '/queue' });
      expect(queue.status).toBe(200);
      expect((JSON.parse(queue.body!) as { reviews: unknown[] }).reviews).toHaveLength(1);

      // The SAME endpoint on the store surface must not moderate.
      const storeQueue = await call({ surface: 'store', method: 'GET', path: '/queue' });
      expect(storeQueue.status).toBe(404);
    } finally {
      env.dispose();
    }
  });

  it('migration created mod_reviews schema + table', async () => {
    const res = await executor.exec(
      MOD,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
      [`mod_${MOD}`],
    );
    const names = res.rows.map((r) => String((r as { table_name: string }).table_name));
    expect(names).toEqual(expect.arrayContaining([TABLE]));
  });

  it('without write:own_tables the module cannot store (insert is FORBIDDEN)', async () => {
    const env = wire(['read:products', 'read:orders'] as ModulePermission[]);
    try {
      const call = serve(env, STUB_ALLOW);
      const res = call({
        method: 'POST',
        path: '/reviews',
        customer: { id: 'cust-' + newId() },
        body: JSON.stringify({ productId, rating: 5, body: 'Should never persist body.' }),
      });
      // The handler awaits repo.create → sdk.tables.exec, which the broker refuses without the grant
      // by throwing an RpcError whose message names the missing permission.
      await expect(res).rejects.toThrow(/write:own_tables/);
    } finally {
      env.dispose();
    }
  });
});
