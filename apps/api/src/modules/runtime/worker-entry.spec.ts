/**
 * runWorker wiring unit test (in-process, no fork).
 * Proves the entry hands the module an SDK whose calls reach the broker, and rejects a module
 * with no activate().
 */
import { RpcPeer } from './rpc';
import { createInMemoryChannelPair } from './worker-channel';
import { ModuleBroker, type BrokerContext } from './module-broker';
import { runWorker, type SovecomModule } from './worker-entry';
import type { ModuleSdk } from './worker-sdk';
import type { BrokerReadPorts } from './broker-ports';

function brokerPorts(): BrokerReadPorts {
  return {
    products: {
      list: () =>
        Promise.resolve({ items: [{ id: 'p1', slug: 'p', title: 'Pen', status: 'active' }] }),
      get: () => Promise.resolve(null),
    },
    categories: { list: () => Promise.resolve({ items: [] }), get: () => Promise.resolve(null) },
    orders: { list: () => Promise.resolve({ items: [] }), get: () => Promise.resolve(null) },
    customers: { list: () => Promise.resolve({ items: [] }), get: () => Promise.resolve(null) },
  } as unknown as BrokerReadPorts;
}

describe('runWorker', () => {
  it('hands the module an SDK whose calls reach the broker', async () => {
    const [core, worker] = createInMemoryChannelPair();
    const corePeer = new RpcPeer(core);
    const ctx: BrokerContext = {
      tenantId: 't1',
      moduleName: 'wishlist',
      grantedPermissions: new Set(['read:products']),
      httpAllowlist: new Set(),
    };
    const executor = {
      exec: () => Promise.reject(new Error('n/a')),
    } as unknown as import('./module-sql.executor').ModuleSqlExecutor;
    const eventBus = {
      subscribe() {},
      emitModuleEvent() {},
      deliverCoreEvent() {},
      unsubscribe() {},
    } as unknown as import('./module-event-bus').ModuleEventBus;
    const mail = {
      send: () => Promise.reject(new Error('n/a')),
    } as unknown as import('./module-mail.port').ModuleMailPort;
    new ModuleBroker(
      brokerPorts(),
      { fetch: () => Promise.reject(new Error('n/a')) },
      executor,
      eventBus,
      mail,
    ).registerOn(corePeer, ctx);

    let seen: unknown;
    const fakeModule: SovecomModule = {
      activate: async (sdk: ModuleSdk) => {
        seen = await sdk.store.products.list();
      },
    };
    const peer = await runWorker(worker, () => fakeModule);
    expect(seen).toMatchObject({ items: [{ title: 'Pen' }] });
    peer.dispose();
    corePeer.dispose();
  });

  it('accepts a CommonJS default-export module', async () => {
    const [, worker] = createInMemoryChannelPair();
    let activated = false;
    const peer = await runWorker(worker, () => ({
      default: { activate: () => (activated = true) },
    }));
    expect(activated).toBe(true);
    peer.dispose();
  });

  it('rejects a module with no activate() function', async () => {
    const [, worker] = createInMemoryChannelPair();
    await expect(runWorker(worker, () => ({ nope: true }))).rejects.toThrow(/activate/);
  });
});
