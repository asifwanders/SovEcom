/**
 * i — `email:send` end-to-end (broker → mail port → MailService + audit) integration.
 *
 * SECURITY-CRITICAL: extends the module sandbox. Against REAL Postgres (the audit_log table) and a
 * recording mail transport, this drives the full path over a real RPC peer:
 *   - a worker WITH `email:send` granted → the message is QUEUED via MailService AND a
 *     `module.email.sent` row lands in the real audit_log (with to/subject, NO body);
 *   - a worker WITHOUT the grant → FORBIDDEN, the transport is NEVER touched;
 *   - a header-injection attempt (CRLF in `to`) → PROTOCOL, never sent, and a deny is audited;
 *   - the per-module rate limit returns RATE_LIMITED after the cap, audited as a deny.
 *
 * The mail port is built here with the booted app's REAL AuditService (→ real PG) + a recording
 * fake transport, mirroring how broker-tables.int-spec wires a real broker over an in-memory pair.
 */
import { and, eq } from 'drizzle-orm';

import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  AuthHarness,
  newId,
} from '../auth/_auth-harness';
import { AuditService } from '../../../src/audit/audit.service';
import { DatabaseService } from '../../../src/database/database.service';
import { auditLog } from '../../../src/database/schema/audit_log';
import { customers } from '../../../src/database/schema/customers';
import { tenants } from '../../../src/database/schema/_tenants';
import { RpcPeer } from '../../../src/modules/runtime/rpc';
import { RpcErrorCode } from '../../../src/modules/runtime/ipc-protocol';
import { createInMemoryChannelPair } from '../../../src/modules/runtime/worker-channel';
import { ModuleBroker, type BrokerContext } from '../../../src/modules/runtime/module-broker';
import type { BrokerReadPorts } from '../../../src/modules/runtime/broker-ports';
import {
  ModuleMailPort,
  FixedWindowRateLimiter,
} from '../../../src/modules/runtime/module-mail.port';
import { CustomerEmailLookupAdapter } from '../../../src/modules/runtime/customer-email-lookup.adapter';
import type { IMailService } from '../../../src/mail/mail.service';

const MOD = 'inotify';
const TENANT = '01900000-0000-7000-8000-000000000000'; // the harness baseline default tenant

function emptyPorts(): BrokerReadPorts {
  const p = { list: () => Promise.resolve({ items: [] }), get: () => Promise.resolve(null) };
  return { products: p, categories: p, orders: p, customers: p } as unknown as BrokerReadPorts;
}

describe('email:send end-to-end (integration)', () => {
  let h: AuthHarness;
  let audit: AuditService;
  let database: DatabaseService;
  let corePeer: RpcPeer;
  let workerPeer: RpcPeer;
  let sent: Array<{ to: string; subject: string; text: string; html?: string }>;

  beforeAll(async () => {
    h = await bootAuthApp();
    audit = h.app.get(AuditService);
    database = h.app.get(DatabaseService);
  });

  afterAll(async () => {
    corePeer?.dispose();
    workerPeer?.dispose();
    await teardownAuthApp(h);
  });

  beforeEach(async () => {
    await resetAuthState(h);
  });

  /** Wire a real broker (with a recording mail transport + real AuditService) over an RPC pair. */
  function wire(grants: string[], limit = 100) {
    corePeer?.dispose();
    workerPeer?.dispose();
    sent = [];
    const mail: IMailService = {
      send: jest.fn(async (opts) => {
        sent.push(opts);
        return { messageId: 'm-int' };
      }),
      sendPasswordReset: jest.fn(),
      sendEmailChangeVerification: jest.fn(),
      sendEmailChangeNotice: jest.fn(),
      sendCustomerPasswordReset: jest.fn(),
    } as unknown as IMailService;
    const port = new ModuleMailPort(mail, audit, new FixedWindowRateLimiter(limit, 60_000));
    const broker = new ModuleBroker(
      emptyPorts(),
      { fetch: jest.fn() } as never,
      { exec: jest.fn() } as never,
      { subscribe() {}, emitModuleEvent() {}, unsubscribe() {} } as never,
      port,
    );
    const [core, worker] = createInMemoryChannelPair();
    corePeer = new RpcPeer(core, { requestTimeoutMs: 2000 });
    workerPeer = new RpcPeer(worker, { requestTimeoutMs: 2000 });
    const ctx: BrokerContext = {
      tenantId: TENANT,
      moduleName: MOD,
      grantedPermissions: new Set(grants as never),
      httpAllowlist: new Set<string>(),
    };
    broker.registerOn(corePeer, ctx);
    return { workerPeer };
  }

  /**
   * Like {@link wire} but with the REAL DB-backed customer-email lookup wired into the mail port, so
   * the `email.sendToCustomer` (B3) path resolves recipients + honours consent/erasure against real
   * PG. Tenant defaults to the harness baseline tenant but is overridable for the cross-tenant case.
   */
  function wireWithLookup(grants: string[], tenantId = TENANT, limit = 100) {
    corePeer?.dispose();
    workerPeer?.dispose();
    sent = [];
    const mail: IMailService = {
      send: jest.fn(async (opts) => {
        sent.push(opts);
        return { messageId: 'm-int' };
      }),
      sendPasswordReset: jest.fn(),
      sendEmailChangeVerification: jest.fn(),
      sendEmailChangeNotice: jest.fn(),
      sendCustomerPasswordReset: jest.fn(),
    } as unknown as IMailService;
    const port = new ModuleMailPort(
      mail,
      audit,
      new FixedWindowRateLimiter(limit, 60_000),
      new CustomerEmailLookupAdapter(database),
    );
    const broker = new ModuleBroker(
      emptyPorts(),
      { fetch: jest.fn() } as never,
      { exec: jest.fn() } as never,
      { subscribe() {}, emitModuleEvent() {}, unsubscribe() {} } as never,
      port,
    );
    const [core, worker] = createInMemoryChannelPair();
    corePeer = new RpcPeer(core, { requestTimeoutMs: 2000 });
    workerPeer = new RpcPeer(worker, { requestTimeoutMs: 2000 });
    const ctx: BrokerContext = {
      tenantId,
      moduleName: MOD,
      grantedPermissions: new Set(grants as never),
      httpAllowlist: new Set<string>(),
    };
    broker.registerOn(corePeer, ctx);
    return { workerPeer };
  }

  /** Seed a customer row under a tenant; returns its id. */
  async function seedCustomer(
    tenantId: string,
    over: Partial<{ acceptsMarketing: boolean; deletedAt: Date; anonymizedAt: Date }> = {},
  ): Promise<{ id: string; email: string }> {
    const email = `be-${newId()}@example.com`;
    const [row] = await h.db
      .insert(customers)
      .values({
        tenantId,
        email,
        acceptsMarketing: over.acceptsMarketing ?? true,
        deletedAt: over.deletedAt ?? null,
        anonymizedAt: over.anonymizedAt ?? null,
      })
      .returning({ id: customers.id });
    return { id: row!.id, email };
  }

  async function auditRows(action: string) {
    return h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, TENANT), eq(auditLog.action, action)));
  }

  it('granted email:send → queued via MailService AND a module.email.sent audit row (no body)', async () => {
    const { workerPeer } = wire(['email:send']);
    const res = (await workerPeer.request('email.send', {
      to: 'buyer@example.com',
      subject: 'Back in stock',
      text: 'Your wishlisted item is available again.',
    })) as { queued: boolean };

    expect(res.queued).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('buyer@example.com');
    expect(sent[0]!.subject).toContain('Back in stock');

    const rows = await auditRows('module.email.sent');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorType).toBe('system');
    const changes = rows[0]!.changes as Record<string, unknown>;
    expect(changes).toMatchObject({ module: MOD, to: 'buyer@example.com' });
    // The body must never be persisted to the audit trail.
    expect(JSON.stringify(changes)).not.toContain('available again');
  });

  it('WITHOUT the grant → FORBIDDEN, no send, no module.email.sent audit row', async () => {
    const { workerPeer } = wire([]); // default-deny
    await expect(
      workerPeer.request('email.send', {
        to: 'buyer@example.com',
        subject: 's',
        text: 't',
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });

    expect(sent).toHaveLength(0);
    expect(await auditRows('module.email.sent')).toHaveLength(0);
  });

  it('header-injection (CRLF in to) → PROTOCOL, never sent, deny audited', async () => {
    const { workerPeer } = wire(['email:send']);
    await expect(
      workerPeer.request('email.send', {
        to: 'buyer@example.com\r\nBcc: evil@x.com',
        subject: 'x',
        text: 't',
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.PROTOCOL });

    expect(sent).toHaveLength(0);
    const denied = await auditRows('module.email.denied');
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect((denied[0]!.changes as Record<string, unknown>).reason).toBe('invalid_params');
  });

  it('over the per-module cap → RATE_LIMITED (not a throw), deny audited', async () => {
    const { workerPeer } = wire(['email:send'], 1);
    await workerPeer.request('email.send', { to: 'a@example.com', subject: 's', text: 't' });
    await expect(
      workerPeer.request('email.send', { to: 'b@example.com', subject: 's', text: 't' }),
    ).rejects.toMatchObject({ code: RpcErrorCode.RATE_LIMITED });

    expect(sent).toHaveLength(1);
    const denied = await auditRows('module.email.denied');
    expect(
      denied.some((r) => (r.changes as Record<string, unknown>).reason === 'rate_limited'),
    ).toBe(true);
  });

  // ── email.sendToCustomer (B3) — the raw broker RPC path, real lookup + real audit ────────────
  describe('email.sendToCustomer (B3)', () => {
    it('(a) WITHOUT email:send → FORBIDDEN, no send, no audit', async () => {
      const { id } = await seedCustomer(TENANT, { acceptsMarketing: true });
      const { workerPeer } = wireWithLookup([]); // default-deny
      await expect(
        workerPeer.request('email.sendToCustomer', {
          customerId: id,
          subject: 'Price drop',
          text: 'An item dropped.',
        }),
      ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
      expect(sent).toHaveLength(0);
      expect(await auditRows('module.email.sent')).toHaveLength(0);
    });

    it('(b) active + accepts_marketing → { queued:true } + module.email.sent audit (no email PII beyond `to`, no body)', async () => {
      const { id, email } = await seedCustomer(TENANT, { acceptsMarketing: true });
      const { workerPeer } = wireWithLookup(['email:send']);
      const res = (await workerPeer.request('email.sendToCustomer', {
        customerId: id,
        subject: 'Price drop on your wishlist',
        text: 'An item you wishlisted dropped in price.',
      })) as { queued: boolean };

      expect(res.queued).toBe(true);
      // (e) the return object is EXACTLY { queued } — no email/recipient PII crosses back.
      expect(Object.keys(res)).toEqual(['queued']);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(email); // core resolved the recipient; the module supplied only the id

      const rows = await auditRows('module.email.sent');
      expect(rows).toHaveLength(1);
      const changes = rows[0]!.changes as Record<string, unknown>;
      expect(changes).toMatchObject({ module: MOD, customerId: id, to: email });
      expect(JSON.stringify(changes)).not.toContain('dropped in price'); // no body in the audit
    });

    it('(c) accepts_marketing=false → { queued:false }, no send, module.email.suppressed audit with NO email', async () => {
      const { id } = await seedCustomer(TENANT, { acceptsMarketing: false });
      const { workerPeer } = wireWithLookup(['email:send']);
      const res = (await workerPeer.request('email.sendToCustomer', {
        customerId: id,
        subject: 'Price drop',
        text: 'An item dropped.',
      })) as { queued: boolean };

      expect(res).toEqual({ queued: false });
      expect(sent).toHaveLength(0);
      const suppressed = await auditRows('module.email.suppressed');
      expect(suppressed).toHaveLength(1);
      const changes = suppressed[0]!.changes as Record<string, unknown>;
      expect(changes).toMatchObject({ module: MOD, customerId: id, reason: 'not_consented' });
      expect(JSON.stringify(changes)).not.toContain('@'); // no email leaked into the audit
      expect(await auditRows('module.email.sent')).toHaveLength(0);
    });

    it('(c) an ERASED (soft-deleted) customer → { queued:false } suppressed (reason: deleted), no send', async () => {
      const { id } = await seedCustomer(TENANT, { acceptsMarketing: true, deletedAt: new Date() });
      const { workerPeer } = wireWithLookup(['email:send']);
      const res = (await workerPeer.request('email.sendToCustomer', {
        customerId: id,
        subject: 'Price drop',
        text: 'An item dropped.',
      })) as { queued: boolean };

      expect(res).toEqual({ queued: false });
      expect(sent).toHaveLength(0);
      const suppressed = await auditRows('module.email.suppressed');
      expect(
        suppressed.some((r) => (r.changes as Record<string, unknown>).reason === 'deleted'),
      ).toBe(true);
    });

    it('(d) cross-tenant customerId → { queued:false } (missing), no send, no cross-tenant read', async () => {
      // A consented customer under a DIFFERENT tenant; the broker ctx tenant is the baseline tenant.
      const [tenantB] = await h.db
        .insert(tenants)
        .values({ name: 'BE Tenant B', slug: `be-tenant-b-${newId()}` })
        .returning({ id: tenants.id });
      try {
        const { id } = await seedCustomer(tenantB!.id, { acceptsMarketing: true });
        const { workerPeer } = wireWithLookup(['email:send']); // ctx tenant = baseline, NOT tenantB
        const res = (await workerPeer.request('email.sendToCustomer', {
          customerId: id,
          subject: 'Price drop',
          text: 'An item dropped.',
        })) as { queued: boolean };

        expect(res).toEqual({ queued: false });
        expect(sent).toHaveLength(0);
        const suppressed = await auditRows('module.email.suppressed');
        expect(
          suppressed.some((r) => (r.changes as Record<string, unknown>).reason === 'missing'),
        ).toBe(true);
      } finally {
        await h.db.delete(tenants).where(eq(tenants.id, tenantB!.id)); // cascades the customer
      }
    });
  });
});
