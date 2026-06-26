/**
 * Module-side SDK round-trip tests (SDK ↔ broker over in-memory channel).
 * Confirms the public-face stubs map to broker calls, surface results, and propagate the
 * broker's permission/refusal errors unchanged.
 *
 * Also tests the `ping` round-trip (liveness watchdog).
 */
import { RpcErrorCode } from './ipc-protocol';
import { RpcPeer } from './rpc';
import { createInMemoryChannelPair } from './worker-channel';
import { ModuleBroker, type BrokerContext } from './module-broker';
import { createModuleSdk } from './worker-sdk';
import type { BrokerReadPorts } from './broker-ports';

function ports(): BrokerReadPorts {
  const ok = <T>(item: T) => ({
    list: () => Promise.resolve({ items: [item] }),
    get: () => Promise.resolve(item),
  });
  return {
    products: ok({ id: 'p1', slug: 'p', title: 'Pen', status: 'active' }),
    categories: ok({ id: 'k1', slug: 'k', name: 'Stationery' }),
    orders: ok({
      id: 'o1',
      number: '1001',
      status: 'paid',
      totalMinor: 500,
      currency: 'EUR',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    customers: ok({
      id: 'c1',
      displayName: 'A',
      locale: 'fr',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    commerce: {
      hasPurchased: (_t: string, customerId: string, _p: string) =>
        Promise.resolve(customerId === 'cust-buyer'),
    },
  } as unknown as BrokerReadPorts;
}

function wire(grants: string[]) {
  const [core, worker] = createInMemoryChannelPair();
  const corePeer = new RpcPeer(core, { requestTimeoutMs: 500 });
  const ctx: BrokerContext = {
    tenantId: 't1',
    moduleName: 'wishlist',
    grantedPermissions: new Set(grants as never),
    httpAllowlist: new Set(['api.example.com']),
  };
  const egress = { fetch: jest.fn().mockResolvedValue({ status: 204, headers: {}, body: '' }) };
  const executor = {
    exec: jest.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 }),
  } as unknown as import('./module-sql.executor').ModuleSqlExecutor;
  const eventBus = {
    subscribe() {},
    emitModuleEvent() {},
    deliverCoreEvent() {},
    unsubscribe() {},
  } as unknown as import('./module-event-bus').ModuleEventBus;
  const mail = {
    send: jest.fn(async () => ({ queued: true as const })),
  } as unknown as import('./module-mail.port').ModuleMailPort;
  new ModuleBroker(ports(), egress, executor, eventBus, mail).registerOn(corePeer, ctx);
  const workerPeer = new RpcPeer(worker, { requestTimeoutMs: 500 });
  return {
    sdk: createModuleSdk(workerPeer),
    egress,
    mail: mail as unknown as { send: jest.Mock },
    dispose: () => (corePeer.dispose(), workerPeer.dispose()),
  };
}

describe('createModuleSdk', () => {
  it('store.products.get round-trips through the broker', async () => {
    const w = wire(['read:products']);
    await expect(w.sdk.store.products.get('p1')).resolves.toMatchObject({ title: 'Pen' });
    w.dispose();
  });

  it('admin.orders.list round-trips through the broker', async () => {
    const w = wire(['read:orders']);
    const res = await w.sdk.admin.orders.list({ limit: 5 });
    expect(res.items[0]).toMatchObject({ number: '1001' });
    w.dispose();
  });

  it('commerce.hasPurchased (granted read:orders) round-trips to a boolean (B1)', async () => {
    const w = wire(['read:orders']);
    await expect(w.sdk.commerce.hasPurchased('cust-buyer', 'prod-1')).resolves.toBe(true);
    await expect(w.sdk.commerce.hasPurchased('cust-other', 'prod-1')).resolves.toBe(false);
    w.dispose();
  });

  it('commerce.hasPurchased without read:orders is FORBIDDEN (B1)', async () => {
    const w = wire([]);
    await expect(w.sdk.commerce.hasPurchased('cust-buyer', 'prod-1')).rejects.toMatchObject({
      code: RpcErrorCode.FORBIDDEN,
    });
    w.dispose();
  });

  it('propagates the broker FORBIDDEN error for an ungranted capability', async () => {
    const w = wire([]); // no grants
    await expect(w.sdk.store.products.list()).rejects.toMatchObject({
      code: RpcErrorCode.FORBIDDEN,
    });
    w.dispose();
  });

  it('http.fetch (granted + allowlisted) round-trips through the broker egress', async () => {
    const w = wire(['http:outbound']);
    await expect(w.sdk.http.fetch({ url: 'https://api.example.com/x' })).resolves.toMatchObject({
      status: 204,
    });
    expect(w.egress.fetch).toHaveBeenCalled();
    w.dispose();
  });

  it('http.fetch without the permission is FORBIDDEN', async () => {
    const w = wire([]);
    await expect(w.sdk.http.fetch({ url: 'https://api.example.com/x' })).rejects.toMatchObject({
      code: RpcErrorCode.FORBIDDEN,
    });
    w.dispose();
  });

  it('tables.query (granted write:own_tables) round-trips through the broker executor', async () => {
    const w = wire(['write:own_tables']);
    await expect(w.sdk.tables.query('SELECT * FROM items')).resolves.toMatchObject({ rowCount: 1 });
    w.dispose();
  });

  it('email.send (granted email:send) round-trips through the broker mail port', async () => {
    const w = wire(['email:send']);
    await expect(
      w.sdk.email.send({ to: 'buyer@example.com', subject: 'Hi', text: 'Body' }),
    ).resolves.toEqual({ queued: true });
    expect(w.mail.send).toHaveBeenCalledTimes(1);
    w.dispose();
  });

  it('email.send without email:send is FORBIDDEN (never reaches the mail port)', async () => {
    const w = wire([]);
    await expect(
      w.sdk.email.send({ to: 'buyer@example.com', subject: 'Hi', text: 'Body' }),
    ).rejects.toMatchObject({ code: RpcErrorCode.FORBIDDEN });
    expect(w.mail.send).not.toHaveBeenCalled();
    w.dispose();
  });

  it('ping round-trips to pong (liveness watchdog)', async () => {
    // The core side (watchdog) sends `ping` to the worker peer; a healthy SDK answers 'pong'.
    const [core, worker] = createInMemoryChannelPair();
    const corePeer = new RpcPeer(core, { requestTimeoutMs: 500 });
    const workerPeer = new RpcPeer(worker, { requestTimeoutMs: 500 });
    // Wire the SDK (which registers the ping handler) on the worker peer.
    createModuleSdk(workerPeer);
    // Core sends ping — the SDK handler must answer 'pong'.
    const result = await corePeer.request('ping', null);
    expect(result).toBe('pong');
    corePeer.dispose();
    workerPeer.dispose();
  });

  it('events.on subscribes + dispatches a core-delivered event to the handler', async () => {
    const [core, worker] = createInMemoryChannelPair();
    const corePeer = new RpcPeer(core, { requestTimeoutMs: 500 });
    corePeer.handle('events.subscribe', () => ({ ok: true })); // stand-in for the broker
    const workerPeer = new RpcPeer(worker, { requestTimeoutMs: 500 });
    const sdk = createModuleSdk(workerPeer);

    const seen: unknown[] = [];
    await sdk.events.on('order.paid', (payload) => {
      seen.push(payload);
    });
    // core delivers the event (the bus would do this in production).
    await corePeer.request('events.deliver', { event: 'order.paid', payload: { orderId: 'o9' } });
    expect(seen).toEqual([{ orderId: 'o9' }]);
    corePeer.dispose();
    workerPeer.dispose();
  });
});
