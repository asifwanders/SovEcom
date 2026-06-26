/**
 * ModuleBroker security unit tests.
 *
 * The broker is registered on a core-side peer; a worker-side peer drives calls over an
 * in-memory channel (real RPC, no fork). Pins every security property of the chokepoint:
 * default-deny permissions, strict params (no tenantId injection), tenant scoping, field-limited
 * PII, categorical transactional-path refusal, and deferred-capability NOT_AVAILABLE.
 *
 * Also tests the per-worker concurrency cap (DoS hardening).
 */
import type { ModulePermission } from '../module-manifest';
import { RpcErrorCode } from './ipc-protocol';
import { RpcPeer } from './rpc';
import { createInMemoryChannelPair } from './worker-channel';
import { ModuleBroker, MAX_INFLIGHT_PER_WORKER, type BrokerContext } from './module-broker';
import type {
  BrokerReadPorts,
  ListQuery,
  ListResult,
  ModuleProductDto,
  ModuleCustomerDto,
} from './broker-ports';

/** Fake ports that echo back the tenantId they were called with, so scoping is observable. */
function fakePorts(): {
  ports: BrokerReadPorts;
  calls: Array<[string, string]>;
  purchaseCalls: Array<{ tenantId: string; customerId: string; productId: string }>;
} {
  const calls: Array<[string, string]> = [];
  const purchaseCalls: Array<{ tenantId: string; customerId: string; productId: string }> = [];
  const list =
    <T>(kind: string, make: (t: string) => T) =>
    (tenantId: string, _q: ListQuery) => {
      calls.push([kind + '.list', tenantId]);
      return Promise.resolve<ListResult<T>>({ items: [make(tenantId)] });
    };
  const get =
    <T>(kind: string, make: (t: string) => T) =>
    (tenantId: string, _id: string) => {
      calls.push([kind + '.get', tenantId]);
      return Promise.resolve<T>(make(tenantId));
    };
  const product = (t: string): ModuleProductDto => ({
    id: 'p1',
    slug: 'p',
    title: `prod-${t}`,
    status: 'active',
  });
  const customer = (t: string): ModuleCustomerDto => ({
    id: 'c1',
    displayName: `cust-${t}`,
    locale: 'fr',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const ports: BrokerReadPorts = {
    products: { list: list('products', product), get: get('products', product) },
    categories: {
      list: list('categories', (t) => ({ id: 'k1', slug: 'k', name: t })),
      get: get('categories', (t) => ({ id: 'k1', slug: 'k', name: t })),
    },
    orders: {
      list: list('orders', () => ({
        id: 'o1',
        number: '1001',
        status: 'paid',
        totalMinor: 1000,
        currency: 'EUR',
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
      get: get('orders', () => ({
        id: 'o1',
        number: '1001',
        status: 'paid',
        totalMinor: 1000,
        currency: 'EUR',
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
    },
    customers: { list: list('customers', customer), get: get('customers', customer) },
    commerce: {
      // Echo the bound params back so a test can assert the broker passed ctx.tenantId (never module
      // input) and the two ids verbatim. Verdict: true only for the canonical (cust-buyer, prod-1).
      hasPurchased: (tenantId, customerId, productId) => {
        purchaseCalls.push({ tenantId, customerId, productId });
        return Promise.resolve(customerId === 'cust-buyer' && productId === 'prod-1');
      },
    },
  };
  return { ports, calls, purchaseCalls };
}

function harness(
  grants: ModulePermission[],
  tenantId = 't1',
  httpAllowlist: string[] = ['api.example.com'],
) {
  const { ports, calls, purchaseCalls } = fakePorts();
  const egress = {
    fetch: jest.fn().mockResolvedValue({ status: 200, headers: {}, body: 'ok' }),
  };
  const executor = {
    exec: jest.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 }),
  } as unknown as import('./module-sql.executor').ModuleSqlExecutor;
  const eventBus = {
    subscribe: jest.fn(),
    emitModuleEvent: jest.fn(),
    deliverCoreEvent: jest.fn(),
    unsubscribe: jest.fn(),
  };
  // A fake mail port — records the (ctx, params) it is asked to send. The broker is responsible
  // ONLY for the permission gate; the port owns validation/rate-limit/audit (tested in its own spec).
  const mailCalls: Array<{ ctx: { tenantId: string; moduleName: string }; params: unknown }> = [];
  const sendToCustomerCalls: Array<{
    ctx: { tenantId: string; moduleName: string };
    params: unknown;
  }> = [];
  const mail = {
    send: jest.fn(async (ctx: { tenantId: string; moduleName: string }, params: unknown) => {
      mailCalls.push({ ctx, params });
      return { queued: true as const };
    }),
    sendToCustomer: jest.fn(
      async (ctx: { tenantId: string; moduleName: string }, params: unknown) => {
        sendToCustomerCalls.push({ ctx, params });
        return { queued: true as const };
      },
    ),
  } as unknown as import('./module-mail.port').ModuleMailPort;
  const broker = new ModuleBroker(
    ports,
    egress,
    executor,
    eventBus as unknown as import('./module-event-bus').ModuleEventBus,
    mail,
  );
  const [core, worker] = createInMemoryChannelPair();
  const corePeer = new RpcPeer(core, { requestTimeoutMs: 500 });
  const ctx: BrokerContext = {
    tenantId,
    moduleName: 'wishlist',
    grantedPermissions: new Set(grants),
    httpAllowlist: new Set(httpAllowlist),
  };
  broker.registerOn(corePeer, ctx);
  const workerPeer = new RpcPeer(worker, { requestTimeoutMs: 500 });
  return {
    workerPeer,
    calls,
    purchaseCalls,
    egress,
    executor: executor as unknown as { exec: jest.Mock },
    eventBus,
    mail: mail as unknown as { send: jest.Mock; sendToCustomer: jest.Mock },
    mailCalls,
    sendToCustomerCalls,
    dispose: () => (corePeer.dispose(), workerPeer.dispose()),
  };
}

describe('ModuleBroker', () => {
  it('allows a granted read capability and tenant-scopes it with the context tenant', async () => {
    const h = harness(['read:products'], 'tenant-A');
    const res = (await h.workerPeer.request('products.list', { limit: 10 })) as {
      items: ModuleProductDto[];
    };
    expect(res.items[0]!.title).toBe('prod-tenant-A');
    expect(h.calls).toEqual([['products.list', 'tenant-A']]); // port called with ctx tenant
    h.dispose();
  });

  it('default-deny: an UNDECLARED permission is FORBIDDEN', async () => {
    const h = harness([]); // no grants
    await expect(h.workerPeer.request('products.list', { limit: 10 })).rejects.toMatchObject({
      code: RpcErrorCode.FORBIDDEN,
    });
    expect(h.calls).toHaveLength(0); // never reached the port
    h.dispose();
  });

  it('a grant for one capability does not unlock another', async () => {
    const h = harness(['read:products']);
    await expect(h.workerPeer.request('orders.list', { limit: 5 })).rejects.toMatchObject({
      code: RpcErrorCode.FORBIDDEN,
    });
    h.dispose();
  });

  it('read:customers returns a FIELD-LIMITED DTO (no email/phone/address/VAT)', async () => {
    const h = harness(['read:customers']);
    const c = (await h.workerPeer.request('customers.get', { id: 'c1' })) as ModuleCustomerDto;
    expect(Object.keys(c).sort()).toEqual(['createdAt', 'displayName', 'id', 'locale']);
    expect(JSON.stringify(c)).not.toMatch(/email|phone|address|vat|@/i);
    h.dispose();
  });

  it('refuses core-table writes + the transactional path CATEGORICALLY (by design)', async () => {
    // Even granted every read perm, the transactional methods are refused.
    const h = harness(['read:products', 'read:orders', 'read:customers', 'read:categories']);
    for (const method of [
      'products.create',
      'orders.update',
      'cart.addItem',
      'checkout.complete',
      'payments.refund',
      'inventory.adjust',
      'customers.delete',
    ]) {
      await expect(h.workerPeer.request(method, {})).rejects.toMatchObject({
        code: RpcErrorCode.FORBIDDEN,
      });
    }
    h.dispose();
  });

  it('slots.register is no longer a runtime method — slots are declarative', async () => {
    // Slots are declared statically in the manifest and the registry is derived from enabled
    // modules' manifests. There is no runtime slot call, so the broker registers no handler for it —
    // a request resolves as a plain UNKNOWN_METHOD, never a silent allow.
    const h = harness([]);
    await expect(h.workerPeer.request('slots.register', {})).rejects.toMatchObject({
      code: RpcErrorCode.UNKNOWN_METHOD,
    });
    h.dispose();
  });

  it('events.subscribe (granted) records the subscription on the bus, tenant+module from ctx', async () => {
    const h = harness(['subscribe:events'], 'tenant-A');
    await h.workerPeer.request('events.subscribe', { events: ['order.paid', 'product.created'] });
    expect(h.eventBus.subscribe).toHaveBeenCalledWith('tenant-A', 'wishlist', expect.anything(), [
      'order.paid',
      'product.created',
    ]);
    h.dispose();
  });

  it('events.subscribe without subscribe:events is FORBIDDEN', async () => {
    const h = harness(['read:products']);
    await expect(
      h.workerPeer.request('events.subscribe', { events: ['order.paid'] }),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
    expect(h.eventBus.subscribe).not.toHaveBeenCalled();
    h.dispose();
  });

  it('events.emit (granted) goes through the bus with ctx tenant+module', async () => {
    const h = harness(['emit:events'], 'tenant-A');
    await h.workerPeer.request('events.emit', { event: 'wishlisted', payload: { id: 1 } });
    expect(h.eventBus.emitModuleEvent).toHaveBeenCalledWith('tenant-A', 'wishlist', 'wishlisted', {
      id: 1,
    });
    h.dispose();
  });

  it('events.emit without emit:events is FORBIDDEN', async () => {
    const h = harness([]);
    await expect(h.workerPeer.request('events.emit', { event: 'x' })).rejects.toMatchObject({
      code: RpcErrorCode.FORBIDDEN,
    });
    expect(h.eventBus.emitModuleEvent).not.toHaveBeenCalled();
    h.dispose();
  });

  it('tables.query/exec with write:own_tables runs via the role-isolated executor', async () => {
    const h = harness(['write:own_tables']);
    const res = (await h.workerPeer.request('tables.query', {
      sql: 'SELECT * FROM items WHERE id = $1',
      params: [1],
    })) as { rowCount: number };
    expect(res.rowCount).toBe(1);
    expect(h.executor.exec).toHaveBeenCalledWith(
      'wishlist',
      'SELECT * FROM items WHERE id = $1',
      [1],
    );
    h.dispose();
  });

  it('tables.* without write:own_tables is FORBIDDEN (never reaches the executor)', async () => {
    const h = harness(['read:products']);
    await expect(
      h.workerPeer.request('tables.exec', { sql: 'DELETE FROM items' }),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
    expect(h.executor.exec).not.toHaveBeenCalled();
    h.dispose();
  });

  it('tables rejects non-primitive params (PROTOCOL)', async () => {
    const h = harness(['write:own_tables']);
    await expect(
      h.workerPeer.request('tables.query', { sql: 'SELECT 1', params: [{ nested: true }] }),
    ).rejects.toMatchObject({ code: RpcErrorCode.PROTOCOL });
    h.dispose();
  });

  it('http.fetch with http:outbound granted + allowlisted host → mediated through the egress port', async () => {
    const h = harness(['http:outbound'], 't1', ['api.example.com']);
    const res = (await h.workerPeer.request('http.fetch', {
      url: 'https://api.example.com/x',
    })) as { status: number; body: string };
    expect(res).toMatchObject({ status: 200, body: 'ok' });
    expect(h.egress.fetch).toHaveBeenCalledWith(
      { url: 'https://api.example.com/x' },
      new Set(['api.example.com']),
    );
    h.dispose();
  });

  it('http.fetch without http:outbound is FORBIDDEN (never reaches the egress port)', async () => {
    const h = harness(['read:products']);
    await expect(
      h.workerPeer.request('http.fetch', { url: 'https://api.example.com/x' }),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
    expect(h.egress.fetch).not.toHaveBeenCalled();
    h.dispose();
  });

  it('rejects params with an injected tenantId (strict schema → PROTOCOL)', async () => {
    const h = harness(['read:products']);
    await expect(
      h.workerPeer.request('products.get', { id: 'p1', tenantId: 'tenant-EVIL' }),
    ).rejects.toMatchObject({ code: RpcErrorCode.PROTOCOL });
    expect(h.calls).toHaveLength(0);
    h.dispose();
  });

  it('rejects malformed params (missing id, oversized limit)', async () => {
    const h = harness(['read:products']);
    await expect(h.workerPeer.request('products.get', {})).rejects.toMatchObject({
      code: RpcErrorCode.PROTOCOL,
    });
    await expect(h.workerPeer.request('products.list', { limit: 9999 })).rejects.toMatchObject({
      code: RpcErrorCode.PROTOCOL,
    });
    h.dispose();
  });

  it('an unknown method is UNKNOWN_METHOD (not a silent allow)', async () => {
    const h = harness(['read:products']);
    await expect(h.workerPeer.request('totally.madeup', {})).rejects.toMatchObject({
      code: RpcErrorCode.UNKNOWN_METHOD,
    });
    h.dispose();
  });

  it('two modules with different tenants each only see their own tenant', async () => {
    const a = harness(['read:products'], 'tenant-A');
    const b = harness(['read:products'], 'tenant-B');
    const ra = (await a.workerPeer.request('products.list', {})) as { items: ModuleProductDto[] };
    const rb = (await b.workerPeer.request('products.list', {})) as { items: ModuleProductDto[] };
    expect(ra.items[0]!.title).toBe('prod-tenant-A');
    expect(rb.items[0]!.title).toBe('prod-tenant-B');
    a.dispose();
    b.dispose();
  });

  // ── email:send permission gate (3.10-i) ──────────────────────────────────────

  it('email.send with email:send granted reaches the mail port, scoped to ctx tenant+module', async () => {
    const h = harness(['email:send'], 'tenant-A');
    const res = (await h.workerPeer.request('email.send', {
      to: 'buyer@example.com',
      subject: 'Back in stock',
      text: 'Your item is available.',
    })) as { queued: boolean };
    expect(res.queued).toBe(true);
    expect(h.mail.send).toHaveBeenCalledTimes(1);
    // The broker passes the CONTEXT identity (never module input) as the first arg.
    expect(h.mailCalls[0]!.ctx).toEqual({ tenantId: 'tenant-A', moduleName: 'wishlist' });
    expect(h.mailCalls[0]!.params).toMatchObject({ to: 'buyer@example.com' });
    h.dispose();
  });

  it('email.send WITHOUT email:send is FORBIDDEN (never reaches the mail port)', async () => {
    const h = harness(['read:products']); // any other grant, but not email:send
    await expect(
      h.workerPeer.request('email.send', {
        to: 'buyer@example.com',
        subject: 's',
        text: 't',
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
    expect(h.mail.send).not.toHaveBeenCalled();
    h.dispose();
  });

  it('default-deny: no grants → email.send is FORBIDDEN', async () => {
    const h = harness([]);
    await expect(
      h.workerPeer.request('email.send', { to: 'b@example.com', subject: 's', text: 't' }),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
    expect(h.mail.send).not.toHaveBeenCalled();
    h.dispose();
  });

  // ── email.sendToCustomer — rides the SAME email:send grant (B3) ───────────────

  it('email.sendToCustomer with email:send granted reaches the mail port, scoped to ctx (no `to`)', async () => {
    const h = harness(['email:send'], 'tenant-A');
    const res = (await h.workerPeer.request('email.sendToCustomer', {
      customerId: '11111111-1111-7111-8111-111111111111',
      subject: 'Price drop',
      text: 'An item dropped.',
    })) as { queued: boolean };
    expect(res.queued).toBe(true);
    expect(h.mail.sendToCustomer).toHaveBeenCalledTimes(1);
    // The broker passes the CONTEXT identity (never module input) as the first arg.
    expect(h.sendToCustomerCalls[0]!.ctx).toEqual({ tenantId: 'tenant-A', moduleName: 'wishlist' });
    expect(h.sendToCustomerCalls[0]!.params).toMatchObject({
      customerId: '11111111-1111-7111-8111-111111111111',
    });
    h.dispose();
  });

  it('email.sendToCustomer WITHOUT email:send is FORBIDDEN (never reaches the mail port)', async () => {
    const h = harness(['read:products']); // any other grant, but not email:send
    await expect(
      h.workerPeer.request('email.sendToCustomer', {
        customerId: '11111111-1111-7111-8111-111111111111',
        subject: 's',
        text: 't',
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
    expect(h.mail.sendToCustomer).not.toHaveBeenCalled();
    h.dispose();
  });

  it('default-deny: no grants → email.sendToCustomer is FORBIDDEN', async () => {
    const h = harness([]);
    await expect(
      h.workerPeer.request('email.sendToCustomer', {
        customerId: '11111111-1111-7111-8111-111111111111',
        subject: 's',
        text: 't',
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
    expect(h.mail.sendToCustomer).not.toHaveBeenCalled();
    h.dispose();
  });

  // ── commerce.hasPurchased — boolean-only purchase probe behind read:orders (B1) ──

  it('commerce.hasPurchased WITHOUT read:orders is FORBIDDEN (never reaches the port)', async () => {
    const h = harness(['read:products']); // any grant but not read:orders
    await expect(
      h.workerPeer.request('commerce.hasPurchased', {
        customerId: 'cust-buyer',
        productId: 'prod-1',
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
    expect(h.purchaseCalls).toHaveLength(0);
    h.dispose();
  });

  it('default-deny: no grants → commerce.hasPurchased is FORBIDDEN', async () => {
    const h = harness([]);
    await expect(
      h.workerPeer.request('commerce.hasPurchased', {
        customerId: 'cust-buyer',
        productId: 'prod-1',
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
    expect(h.purchaseCalls).toHaveLength(0);
    h.dispose();
  });

  it('granted read:orders → returns ONLY a boolean, tenant-scoped from ctx (never module input)', async () => {
    const h = harness(['read:orders'], 'tenant-Z');
    const yes = await h.workerPeer.request('commerce.hasPurchased', {
      customerId: 'cust-buyer',
      productId: 'prod-1',
    });
    expect(yes).toBe(true);
    expect(typeof yes).toBe('boolean');
    const no = await h.workerPeer.request('commerce.hasPurchased', {
      customerId: 'cust-other',
      productId: 'prod-1',
    });
    expect(no).toBe(false);
    // The port was called with the CONTEXT tenant + the verbatim ids — never a module-supplied tenant.
    expect(h.purchaseCalls).toEqual([
      { tenantId: 'tenant-Z', customerId: 'cust-buyer', productId: 'prod-1' },
      { tenantId: 'tenant-Z', customerId: 'cust-other', productId: 'prod-1' },
    ]);
    h.dispose();
  });

  it('rejects an injected tenantId on commerce.hasPurchased (strict schema → PROTOCOL)', async () => {
    const h = harness(['read:orders']);
    await expect(
      h.workerPeer.request('commerce.hasPurchased', {
        customerId: 'cust-buyer',
        productId: 'prod-1',
        tenantId: 'tenant-EVIL',
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.PROTOCOL });
    expect(h.purchaseCalls).toHaveLength(0);
    h.dispose();
  });

  it('rejects malformed commerce.hasPurchased params (missing id, oversized id)', async () => {
    const h = harness(['read:orders']);
    await expect(
      h.workerPeer.request('commerce.hasPurchased', { customerId: 'cust-buyer' }),
    ).rejects.toMatchObject({ code: RpcErrorCode.PROTOCOL });
    await expect(
      h.workerPeer.request('commerce.hasPurchased', {
        customerId: 'x'.repeat(65),
        productId: 'prod-1',
      }),
    ).rejects.toMatchObject({ code: RpcErrorCode.PROTOCOL });
    expect(h.purchaseCalls).toHaveLength(0);
    h.dispose();
  });

  // ── Per-worker concurrency cap (DoS hardening) ──────────────────────────────

  it(`fires MAX_INFLIGHT_PER_WORKER+1 concurrent slow calls → the overflow rejects with BUSY`, async () => {
    // We need a slow handler so calls actually pile up. Build a harness with a custom products
    // port whose list() never resolves until we release it. This lets us hold exactly
    // MAX_INFLIGHT_PER_WORKER calls in-flight while sending one more.
    let releaseAll: () => void;
    const gate = new Promise<void>((res) => (releaseAll = res));

    const slowPorts: import('./broker-ports').BrokerReadPorts = {
      products: {
        list: () => gate.then(() => ({ items: [] })),
        get: () => gate.then(() => null),
      },
      categories: {
        list: () => gate.then(() => ({ items: [] })),
        get: () => gate.then(() => null),
      },
      orders: {
        list: () => gate.then(() => ({ items: [] })),
        get: () => gate.then(() => null),
      },
      customers: {
        list: () => gate.then(() => ({ items: [] })),
        get: () => gate.then(() => null),
      },
      commerce: {
        hasPurchased: () => gate.then(() => false),
      },
    } as unknown as import('./broker-ports').BrokerReadPorts;

    const egress = { fetch: jest.fn() };
    const executor = {
      exec: jest.fn().mockReturnValue(gate.then(() => ({ rows: [], rowCount: 0 }))),
    } as unknown as import('./module-sql.executor').ModuleSqlExecutor;
    const eventBus = {
      subscribe: jest.fn(),
      emitModuleEvent: jest.fn(),
      deliverCoreEvent: jest.fn(),
      unsubscribe: jest.fn(),
    };
    const mail = {
      send: jest.fn(async () => ({ queued: true as const })),
    } as unknown as import('./module-mail.port').ModuleMailPort;
    const broker = new ModuleBroker(
      slowPorts,
      egress,
      executor,
      eventBus as unknown as import('./module-event-bus').ModuleEventBus,
      mail,
    );
    const [core, worker] = createInMemoryChannelPair();
    const corePeer = new RpcPeer(core, { requestTimeoutMs: 2000 });
    const ctx: BrokerContext = {
      tenantId: 'tenant-cap',
      moduleName: 'heavy',
      grantedPermissions: new Set(['read:products'] as ModulePermission[]),
      httpAllowlist: new Set<string>(),
    };
    broker.registerOn(corePeer, ctx);
    const workerPeer = new RpcPeer(worker, { requestTimeoutMs: 2000 });

    // Fire exactly MAX_INFLIGHT_PER_WORKER requests that are all blocked on `gate`.
    const inflight = Array.from({ length: MAX_INFLIGHT_PER_WORKER }, () =>
      workerPeer.request('products.list', {}),
    );
    // Give the event loop a tick so those requests reach the broker handlers.
    await new Promise((r) => setTimeout(r, 0));

    // The next call should be rejected immediately with BUSY.
    await expect(workerPeer.request('products.list', {})).rejects.toMatchObject({
      code: RpcErrorCode.BUSY,
    });

    // Release the gate so the in-flight calls resolve and we can clean up.
    releaseAll!();
    await Promise.allSettled(inflight);
    corePeer.dispose();
    workerPeer.dispose();
  });
});
