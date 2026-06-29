/**
 * iii — Notify-back-in-stock reference module END-TO-END integration (real Postgres,
 * real runtime). Mirrors wishlist.int-spec.ts.
 *
 * Installs the actual `modules/notify-back-in-stock` module and drives it through the REAL module
 * runtime:
 *   - provision the module's PG schema + low-privilege role, open its dedicated connection;
 *   - wire a REAL ModuleBroker (real read adapter for product-title enrichment, real mail port with
 *     a recording transport, real SQL executor) over an in-memory RPC channel pair;
 *   - build the worker-side SDK and run the module's OWN `defineModule({ activate })` — its real
 *     migration creates `mod_notify-back-in-stock_subscriptions` in its schema and its `sdk.serve`
 *     handler is registered;
 *   - drive the mounted endpoint over `http.handle` exactly as the store proxy would — proving the
 *     GUEST subscribe path works with NO customer auth, and that a verified `customer` (the
 *     3.10-i.5 bridge) is accepted+recorded when present;
 *   - assert subscribe (guest) stores a row, invalid email → 400, then trigger the restock runner
 *     and assert an email is QUEUED via the recording transport + notified_at is set, and a re-run
 *     queues nothing (idempotency); plus tenant/schema scoping.
 *
 * The HTTP-proxy→forked-worker path is intentionally NOT used (the runtime forks a compiled
 * dist/worker-entry.js that does not exist under ts-jest — see modules-chunk-e.int-spec.ts). This
 * suite exercises the same broker + SDK + `http.handle` contract over an in-memory peer pair, which
 * is the established real-runtime integration pattern (wishlist / broker-tables / broker-email).
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
import type { IMailService } from '../../../src/mail/mail.service';
import type { ModuleHttpRequest, ModuleHttpResponse, ModuleSdk } from '@sovecom/module-sdk';

// The module under test. ts-jest resolves the workspace package to its TS source.
import notifyModule, {
  runBackInStockNotifications,
} from '../../../../../modules/notify-back-in-stock/src/index';
import { NotifyRepository } from '../../../../../modules/notify-back-in-stock/src/db/repository';
import { resolveSettings } from '../../../../../modules/notify-back-in-stock/src/settings';

const MOD = 'notify-back-in-stock';
const TENANT = DEFAULT_TENANT_ID;
// The module's table identifier is double-quoted (the hyphenated module name is not a legal
// unquoted SQL identifier) — used for the per-test TRUNCATE.
const TABLE_QUOTED = '"mod_notify-back-in-stock_subscriptions"';

interface Harness {
  corePeer: RpcPeer;
  workerPeer: RpcPeer;
  sdk: ModuleSdk;
  sent: Array<{ to: string; subject: string; text: string }>;
  dispose: () => void;
}

describe('Notify-back-in-stock module end-to-end (integration, real PG)', () => {
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

    // Seed the default tenant + a product so restock-email title enrichment has something to resolve.
    await db.db
      .insert(tenants)
      .values({ id: TENANT, name: 'Default', slug: 'default' })
      .onConflictDoNothing();
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

  // Each test runs against a clean module table (it persists in the shared schema otherwise). The
  // table is created by the first activate()'s migration; truncate is best-effort before that.
  beforeEach(async () => {
    await executor.exec(MOD, `TRUNCATE TABLE ${TABLE_QUOTED}`).catch(() => undefined);
  });

  /**
   * Wire a real broker (read adapter + executor + recording mail port) over an RPC pair, build the
   * worker SDK, and run the notify module's real `activate(sdk)` (migration + serve registration).
   */
  async function activate(grants: string[]): Promise<Harness> {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const mail: IMailService = {
      send: async (opts: { to: string; subject: string; text: string }) => {
        sent.push(opts);
        return { messageId: 'm-int' };
      },
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
      grantedPermissions: new Set(grants as never),
      httpAllowlist: new Set<string>(),
    };
    broker.registerOn(corePeer, ctx);

    const sdk = createModuleSdk(workerPeer);
    // Run the module's REAL activate — creates the subscriptions table + registers the serve handler.
    await notifyModule.activate(sdk);

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
      path: '/subscriptions',
      query: {},
      headers: {},
      ...partial,
    };
    return (await core.request('http.handle', req)) as ModuleHttpResponse;
  }

  const ALL_GRANTS = ['read:products', 'write:own_tables', 'subscribe:events', 'email:send'];

  it('migration ran: mod_notify-back-in-stock schema + table exist after activate', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const res = await executor.exec(
        MOD,
        `SELECT table_name FROM information_schema.tables
           WHERE table_schema = $1 ORDER BY table_name`,
        [`mod_${MOD}`],
      );
      const names = res.rows.map((r) => String((r as { table_name: string }).table_name));
      expect(names).toEqual(expect.arrayContaining(['mod_notify-back-in-stock_subscriptions']));
    } finally {
      env.dispose();
    }
  });

  it('GUEST subscribe (no customer auth) → 201, row stored email-keyed', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const res = await call(env.corePeer, {
        method: 'POST',
        path: '/subscriptions',
        body: JSON.stringify({ variantId: productId, email: 'guest@example.com' }),
        // NOTE: NO customer field — this is the anonymous guest path.
      });
      expect(res.status).toBe(201);
      const body = JSON.parse(res.body!) as { variantId: string; email: string };
      expect(body).toEqual({ variantId: productId, email: 'guest@example.com' });

      // The row landed, keyed by email, with no customer id.
      const rows = await executor.exec(
        MOD,
        `SELECT customer_email, customer_id, notified_at FROM ${TABLE_QUOTED}
           WHERE product_variant_id = $1`,
        [productId],
      );
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as { customer_email: string }).customer_email).toBe('guest@example.com');
      expect((rows.rows[0] as { customer_id: string | null }).customer_id).toBeNull();
      expect((rows.rows[0] as { notified_at: string | null }).notified_at).toBeNull();
    } finally {
      env.dispose();
    }
  });

  it('records the core-verified customer id when present', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const cust = 'cust-' + newId();
      await call(env.corePeer, {
        method: 'POST',
        path: '/subscriptions',
        body: JSON.stringify({ variantId: productId, email: 'member@example.com' }),
        customer: { id: cust },
      });
      const rows = await executor.exec(
        MOD,
        `SELECT customer_id FROM ${TABLE_QUOTED} WHERE customer_email = $1`,
        ['member@example.com'],
      );
      expect((rows.rows[0] as { customer_id: string }).customer_id).toBe(cust);
    } finally {
      env.dispose();
    }
  });

  it('invalid email → 400, nothing stored', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const res = await call(env.corePeer, {
        method: 'POST',
        path: '/subscriptions',
        body: JSON.stringify({ variantId: productId, email: 'a@example.com,b@evil.com' }),
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body!)).toEqual({ error: 'invalid_email' });
      const rows = await executor.exec(MOD, `SELECT id FROM ${TABLE_QUOTED}`);
      expect(rows.rows).toHaveLength(0);
    } finally {
      env.dispose();
    }
  });

  it('restock runner: queues ONE email per pending subscriber, sets notified_at, re-run no-ops', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const v = 'restock-' + newId();
      // Two guests subscribe to the same variant via the real endpoint.
      for (const email of ['one@example.com', 'two@example.com']) {
        await call(env.corePeer, {
          method: 'POST',
          path: '/subscriptions',
          body: JSON.stringify({ variantId: v, email }),
        });
      }

      const repo = new NotifyRepository(env.sdk.tables);
      const result = await runBackInStockNotifications(
        { restockedVariantIds: [v] },
        {
          repo,
          store: env.sdk.store,
          email: env.sdk.email,
          settings: resolveSettings({ enabled: true }),
        },
      );
      expect(result.sent).toBe(2);
      expect(env.sent).toHaveLength(2);
      expect(env.sent.map((m) => m.to).sort()).toEqual(['one@example.com', 'two@example.com']);
      expect(env.sent[0]!.subject).toMatch(/back in stock/i);

      // notified_at set on both rows.
      const after = await executor.exec(
        MOD,
        `SELECT notified_at FROM ${TABLE_QUOTED} WHERE product_variant_id = $1`,
        [v],
      );
      expect(after.rows).toHaveLength(2);
      for (const r of after.rows) {
        expect((r as { notified_at: string | null }).notified_at).not.toBeNull();
      }

      // Idempotent re-run queues nothing further.
      const again = await runBackInStockNotifications(
        { restockedVariantIds: [v] },
        {
          repo,
          store: env.sdk.store,
          email: env.sdk.email,
          settings: resolveSettings({ enabled: true }),
        },
      );
      expect(again.sent).toBe(0);
      expect(env.sent).toHaveLength(2);
    } finally {
      env.dispose();
    }
  });

  it('re-subscribe resets notified_at so a returning subscriber is re-notified on the next restock', async () => {
    const env = await activate(ALL_GRANTS);
    try {
      const v = 'resub-' + newId();
      const repo = new NotifyRepository(env.sdk.tables);
      const settings = resolveSettings({ enabled: true });

      await call(env.corePeer, {
        method: 'POST',
        path: '/subscriptions',
        body: JSON.stringify({ variantId: v, email: 'again@example.com' }),
      });
      await runBackInStockNotifications(
        { restockedVariantIds: [v] },
        { repo, store: env.sdk.store, email: env.sdk.email, settings },
      );
      expect(env.sent).toHaveLength(1);

      // Re-subscribe (same email + variant) — should reset notified_at to NULL.
      await call(env.corePeer, {
        method: 'POST',
        path: '/subscriptions',
        body: JSON.stringify({ variantId: v, email: 'again@example.com' }),
      });
      // Still exactly one row (no duplicate).
      const rows = await executor.exec(
        MOD,
        `SELECT notified_at FROM ${TABLE_QUOTED} WHERE product_variant_id = $1`,
        [v],
      );
      expect(rows.rows).toHaveLength(1);
      expect((rows.rows[0] as { notified_at: string | null }).notified_at).toBeNull();

      // A second restock now re-notifies them.
      const second = await runBackInStockNotifications(
        { restockedVariantIds: [v] },
        { repo, store: env.sdk.store, email: env.sdk.email, settings },
      );
      expect(second.sent).toBe(1);
      expect(env.sent).toHaveLength(2);
    } finally {
      env.dispose();
    }
  });

  it('without write:own_tables the module cannot store (activate migration is FORBIDDEN)', async () => {
    await expect(activate(['read:products'])).rejects.toBeDefined();
  });
});
