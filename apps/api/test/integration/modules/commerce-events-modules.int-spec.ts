/**
 * Follow-up B2 — the two reference modules driven by the observational commerce events over the
 * REAL module-event bus + REAL broker (real Postgres). Proves the END-TO-END event-driven wiring:
 *
 *   - Wishlist subscribes to `product.price_changed` via the real bus; a DROP event fans to the
 *     worker's handler, which runs the idempotent price-drop digest and QUEUES one email via the
 *     real mail port. A redelivered identical drop queues nothing further (the digest ledger).
 *   - Notify subscribes to `product.stock_changed`; a back-IN-stock event (`available:true`) fans to
 *     the worker, which runs the idempotent restock notifier and QUEUES one email. A redelivered
 *     event queues nothing (the `notified_at` reservation). A depletion event (`available:false`)
 *     queues nothing.
 *
 * Real path: `ModuleEventBus.deliverCoreEvent(...)` → worker peer `events.deliver` → the handler
 * `registerSubscriptions` registered during wiring → the module's own idempotent runner → the real
 * `ModuleMailPort` recording transport. Each module's `registerSubscriptions` is wired with REAL
 * deps (its repo over the broker SQL executor, `sdk.email`, settings) — the same shape `activate`
 * uses. For Wishlist (B3) the digest emails via `sendToCustomer`, so the recipient is resolved by
 * the real DB-backed `CustomerEmailLookupAdapter` from a seeded, marketing-consented customer row —
 * the module supplies only the customer id and never sees the address.
 *
 * Re-runnable against the persistent dev DB: customers/variants are namespaced per run (newId), and
 * each module's tables are truncated per test. No raw control bytes.
 */
import {
  bootAuthApp,
  teardownAuthApp,
  AuthHarness,
  DEFAULT_TENANT_ID,
  newId,
} from '../auth/_auth-harness';
import { AuditService } from '../../../src/audit/audit.service';
import { DatabaseService } from '../../../src/database/database.service';
import { RpcPeer } from '../../../src/modules/runtime/rpc';
import { createInMemoryChannelPair } from '../../../src/modules/runtime/worker-channel';
import { createModuleSdk } from '../../../src/modules/runtime/worker-sdk';
import { ModuleBroker, type BrokerContext } from '../../../src/modules/runtime/module-broker';
import { ModuleEventBus } from '../../../src/modules/runtime/module-event-bus';
import { BrokerReadAdapter } from '../../../src/modules/runtime/broker-read.adapter';
import { ModuleDbProvisioner } from '../../../src/modules/runtime/module-db.provisioner';
import { ModuleSqlExecutor } from '../../../src/modules/runtime/module-sql.executor';
import {
  ModuleMailPort,
  FixedWindowRateLimiter,
} from '../../../src/modules/runtime/module-mail.port';
import { CustomerEmailLookupAdapter } from '../../../src/modules/runtime/customer-email-lookup.adapter';
import { customers } from '../../../src/database/schema/customers';
import type { IMailService } from '../../../src/mail/mail.service';
import type { ModuleSdk } from '@sovecom/module-sdk';

// The modules under test (ts-jest resolves the workspace packages to TS source).
import { registerSubscriptions as registerWishlist } from '../../../../../modules/wishlist/src/events/subscriptions';
import { WishlistRepository } from '../../../../../modules/wishlist/src/db/repository';
import { resolveSettings as wishlistSettings } from '../../../../../modules/wishlist/src/settings';
import { MIGRATION_STATEMENTS as WISHLIST_MIGRATIONS } from '../../../../../modules/wishlist/src/db/schema';
import { registerSubscriptions as registerNotify } from '../../../../../modules/notify-back-in-stock/src/events/subscriptions';
import { NotifyRepository } from '../../../../../modules/notify-back-in-stock/src/db/repository';
import { resolveSettings as notifySettings } from '../../../../../modules/notify-back-in-stock/src/settings';
import { MIGRATION_STATEMENTS as NOTIFY_MIGRATIONS } from '../../../../../modules/notify-back-in-stock/src/db/schema';

const TENANT = DEFAULT_TENANT_ID;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 40));


interface Wired {
  sdk: ModuleSdk;
  sent: Array<{ to: string; subject: string; text: string }>;
  dispose: () => void;
}

describe('B2 modules over the real commerce-event bus (integration, real PG)', () => {
  let h: AuthHarness;
  let db: DatabaseService;
  let audit: AuditService;
  let bus: ModuleEventBus;
  let provisioner: ModuleDbProvisioner;
  let executor: ModuleSqlExecutor;

  beforeAll(async () => {
    h = await bootAuthApp();
    db = h.app.get(DatabaseService);
    audit = h.app.get(AuditService);
    bus = h.app.get(ModuleEventBus);
    provisioner = new ModuleDbProvisioner(db);
    executor = new ModuleSqlExecutor(db);
    for (const mod of ['wishlist', 'notify-back-in-stock']) {
      await provisioner.deprovision(mod).catch(() => undefined);
      await provisioner.provision(mod);
      executor.open(mod, await provisioner.rotateCredential(mod));
    }
    // Run each module's own idempotent migration to create its namespaced tables.
    for (const sql of WISHLIST_MIGRATIONS) await executor.exec('wishlist', sql);
    for (const sql of NOTIFY_MIGRATIONS) await executor.exec('notify-back-in-stock', sql);
  });

  afterAll(async () => {
    for (const mod of ['wishlist', 'notify-back-in-stock']) {
      await executor.close(mod).catch(() => undefined);
      await provisioner.deprovision(mod).catch(() => undefined);
    }
    await teardownAuthApp(h);
  });

  /**
   * Wire a real broker (real executor + real bus + recording mail port) over an RPC pair for the
   * given module, build the worker SDK, and create the module's tables. Returns the sdk + the
   * recorded outbound mail. The caller registers the module's subscriptions on `sdk.events`.
   */
  function wire(mod: string): Wired {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const mail: IMailService = {
      send: async (opts: { to: string; subject: string; text: string }) => {
        sent.push(opts);
        return { messageId: 'm-int' };
      },
    } as unknown as IMailService;
    const mailPort = new ModuleMailPort(
      mail,
      audit,
      new FixedWindowRateLimiter(100, 60_000),
      new CustomerEmailLookupAdapter(db), // B3: real consent/erasure-aware recipient resolution.
    );
    const broker = new ModuleBroker(
      new BrokerReadAdapter(db),
      { fetch: () => Promise.reject(new Error('no egress')) } as never,
      executor,
      bus,
      mailPort,
    );
    const [core, worker] = createInMemoryChannelPair();
    const corePeer = new RpcPeer(core, { requestTimeoutMs: 5000 });
    const workerPeer = new RpcPeer(worker, { requestTimeoutMs: 5000 });
    const ctx: BrokerContext = {
      tenantId: TENANT,
      moduleName: mod,
      grantedPermissions: new Set([
        'read:products',
        'write:own_tables',
        'subscribe:events',
        'email:send',
      ] as never),
      httpAllowlist: new Set<string>(),
    };
    broker.registerOn(corePeer, ctx);
    return {
      sdk: createModuleSdk(workerPeer),
      sent,
      dispose: () => {
        bus.unsubscribe(TENANT, mod);
        corePeer.dispose();
        workerPeer.dispose();
      },
    };
  }

  // ── Wishlist: product.price_changed → digest email ───────────────────────────

  /**
   * Seed a real customer the digest can address by uuid (core resolves the email behind B3). The
   * email is namespaced per call (the active-email partial-unique index forbids reusing one on the
   * persistent dev DB). Returns the id + the seeded email so the test can assert the resolved `to`.
   */
  async function seedWlCustomer(
    acceptsMarketing = true,
  ): Promise<{ id: string; email: string }> {
    const email = `wl-${newId()}@example.com`;
    const [row] = await db.db
      .insert(customers)
      .values({ tenantId: TENANT, email, acceptsMarketing })
      .returning({ id: customers.id });
    return { id: row!.id, email };
  }

  it('Wishlist: a price-drop event over the bus queues a digest email (idempotent)', async () => {
    await executor.exec('wishlist', 'TRUNCATE TABLE mod_wishlist_items, mod_wishlist_digest_log');
    const env = wire('wishlist');
    try {
      const repo = new WishlistRepository(env.sdk.tables);
      const { id: customerId, email } = await seedWlCustomer(true);
      const variantId = 'v-' + newId();
      await repo.add(customerId, variantId);

      // Register the price-drop subscription with REAL deps (B3: email resolved by core).
      await registerWishlist(env.sdk.events, {
        priceDrop: {
          digest: { repo, email: env.sdk.email, settings: wishlistSettings({ weeklyDigest: true }) },
        },
      });

      const drop = {
        eventId: 'evt-' + newId(),
        productId: 'p-' + newId(),
        variantId,
        oldPriceMinor: 3000,
        newPriceMinor: 1999,
        currency: 'EUR',
      };
      bus.deliverCoreEvent('product.price_changed', TENANT, drop);
      await tick();

      expect(env.sent).toHaveLength(1);
      expect(env.sent[0]!.to).toBe(email);
      expect(env.sent[0]!.subject).toMatch(/price drop/i);

      // Redeliver the SAME event (same eventId) → the digest ledger dedupes → no 2nd email.
      bus.deliverCoreEvent('product.price_changed', TENANT, drop);
      await tick();
      expect(env.sent).toHaveLength(1);
    } finally {
      env.dispose();
    }
  });

  it('Wishlist (B3): a price-drop for a NON-consented customer is SUPPRESSED (no email)', async () => {
    await executor.exec('wishlist', 'TRUNCATE TABLE mod_wishlist_items, mod_wishlist_digest_log');
    const env = wire('wishlist');
    try {
      const repo = new WishlistRepository(env.sdk.tables);
      const { id: customerId } = await seedWlCustomer(false); // accepts_marketing = false
      const variantId = 'v-' + newId();
      await repo.add(customerId, variantId);
      await registerWishlist(env.sdk.events, {
        priceDrop: {
          digest: { repo, email: env.sdk.email, settings: wishlistSettings({ weeklyDigest: true }) },
        },
      });
      bus.deliverCoreEvent('product.price_changed', TENANT, {
        eventId: 'evt-' + newId(),
        productId: 'p-' + newId(),
        variantId,
        oldPriceMinor: 3000,
        newPriceMinor: 1999,
        currency: 'EUR',
      });
      await tick();
      // Core suppressed the promotional send (no marketing consent) → nothing queued.
      expect(env.sent).toHaveLength(0);
    } finally {
      env.dispose();
    }
  });

  it('Wishlist SF1: two DISTINCT drops of the same magnitude (distinct eventIds) BOTH email', async () => {
    await executor.exec('wishlist', 'TRUNCATE TABLE mod_wishlist_items, mod_wishlist_digest_log');
    const env = wire('wishlist');
    try {
      const repo = new WishlistRepository(env.sdk.tables);
      const { id: customerId } = await seedWlCustomer(true);
      const variantId = 'v-' + newId();
      await repo.add(customerId, variantId);
      await registerWishlist(env.sdk.events, {
        priceDrop: {
          digest: { repo, email: env.sdk.email, settings: wishlistSettings({ weeklyDigest: true }) },
        },
      });
      // A flash-sale cycle: 3000→1999 twice, each a genuinely distinct emit (distinct eventId).
      const base = { productId: 'p-' + newId(), variantId, oldPriceMinor: 3000, newPriceMinor: 1999, currency: 'EUR' };
      bus.deliverCoreEvent('product.price_changed', TENANT, { eventId: 'evt-' + newId(), ...base });
      await tick();
      bus.deliverCoreEvent('product.price_changed', TENANT, { eventId: 'evt-' + newId(), ...base });
      await tick();
      // Distinct eventIds → two distinct digest runs → BOTH email (no false dedup).
      expect(env.sent).toHaveLength(2);
    } finally {
      env.dispose();
    }
  });

  it('Wishlist: a price RISE event over the bus queues nothing', async () => {
    await executor.exec('wishlist', 'TRUNCATE TABLE mod_wishlist_items, mod_wishlist_digest_log');
    const env = wire('wishlist');
    try {
      const repo = new WishlistRepository(env.sdk.tables);
      const { id: customerId } = await seedWlCustomer(true);
      const variantId = 'v-' + newId();
      await repo.add(customerId, variantId);
      await registerWishlist(env.sdk.events, {
        priceDrop: {
          digest: { repo, email: env.sdk.email, settings: wishlistSettings({ weeklyDigest: true }) },
        },
      });
      bus.deliverCoreEvent('product.price_changed', TENANT, {
        eventId: 'evt-' + newId(),
        productId: 'p-' + newId(),
        variantId,
        oldPriceMinor: 1999,
        newPriceMinor: 3000, // a RISE, not a drop
        currency: 'EUR',
      });
      await tick();
      expect(env.sent).toHaveLength(0);
    } finally {
      env.dispose();
    }
  });

  // ── Notify: product.stock_changed → restock email ────────────────────────────

  it('Notify: a back-in-stock event over the bus queues a restock email (idempotent)', async () => {
    await executor.exec('notify-back-in-stock', 'TRUNCATE TABLE "mod_notify-back-in-stock_subscriptions"');
    const env = wire('notify-back-in-stock');
    try {
      const repo = new NotifyRepository(env.sdk.tables);
      const variantId = 'v-' + newId();
      await repo.subscribe('nb@example.com', variantId, null);

      await registerNotify(env.sdk.events, {
        restock: { notify: { repo, store: env.sdk.store, email: env.sdk.email, settings: notifySettings(undefined) } },
      });

      bus.deliverCoreEvent('product.stock_changed', TENANT, {
        eventId: 'evt-' + newId(),
        productId: 'p-' + newId(),
        variantId,
        available: true,
      });
      await tick();

      expect(env.sent).toHaveLength(1);
      expect(env.sent[0]!.to).toBe('nb@example.com');
      expect(env.sent[0]!.subject.length).toBeGreaterThan(0);

      // Redeliver → notified_at already set → no 2nd email (one-shot per subscription).
      bus.deliverCoreEvent('product.stock_changed', TENANT, {
        eventId: 'evt-' + newId(),
        productId: 'p-' + newId(),
        variantId,
        available: true,
      });
      await tick();
      expect(env.sent).toHaveLength(1);
    } finally {
      env.dispose();
    }
  });

  it('Notify: a depletion event (available:false) over the bus queues nothing', async () => {
    await executor.exec('notify-back-in-stock', 'TRUNCATE TABLE "mod_notify-back-in-stock_subscriptions"');
    const env = wire('notify-back-in-stock');
    try {
      const repo = new NotifyRepository(env.sdk.tables);
      const variantId = 'v-' + newId();
      await repo.subscribe('nb@example.com', variantId, null);
      await registerNotify(env.sdk.events, {
        restock: { notify: { repo, store: env.sdk.store, email: env.sdk.email, settings: notifySettings(undefined) } },
      });
      bus.deliverCoreEvent('product.stock_changed', TENANT, {
        eventId: 'evt-' + newId(),
        productId: 'p-' + newId(),
        variantId,
        available: false, // depletion → not a back-in-stock signal
      });
      await tick();
      expect(env.sent).toHaveLength(0);
    } finally {
      env.dispose();
    }
  });
});
