/**
 * WorkerHost lifecycle unit tests (in-memory channel; no real fork).
 *
 * Pins: start wires a peer + registers the broker handlers; a duplicate start throws; stop
 * tears the worker down; and — critically — a worker channel CLOSING (crash/OOM/kill) marks it
 * stopped and drops it WITHOUT throwing into core (crash isolation).
 */
import { RpcPeer } from './rpc';
import { WorkerHost, type WorkerSpec, type WorkerIdentity } from './worker-host';
import { createInMemoryChannelPair, type WorkerChannel } from './worker-channel';

const SPEC: WorkerSpec = {
  tenantId: 't1',
  name: 'wishlist',
  entry: '/unused/in/memory',
  allowFsRead: [],
  allowFsWrite: [],
};

/**
 * A factory that returns the CORE end of an in-memory pair and stashes the WORKER end so the
 * test can drive it (respond to pings, or close to simulate a crash).
 */
function memoryFactory(): {
  factory: (spec: WorkerSpec) => WorkerChannel;
  workerEnd: (tenantId: string, name: string) => WorkerChannel;
} {
  const ends = new Map<string, WorkerChannel>();
  return {
    factory: (spec) => {
      const [core, worker] = createInMemoryChannelPair();
      ends.set(`${spec.tenantId}/${spec.name}`, worker);
      return core;
    },
    workerEnd: (tenantId, name) => ends.get(`${tenantId}/${name}`)!,
  };
}

describe('WorkerHost', () => {
  it('starts a worker, registers handlers, and tracks it as running', () => {
    const { factory } = memoryFactory();
    const registered: WorkerIdentity[] = [];
    const host = new WorkerHost(factory, (_peer, id) => registered.push(id));

    const handle = host.start(SPEC);
    expect(handle.status).toBe('running');
    expect(registered).toEqual([{ tenantId: 't1', name: 'wishlist' }]);
    expect(host.get('t1', 'wishlist')).toBe(handle);
    expect(host.list()).toHaveLength(1);
  });

  it('refuses a duplicate start for the same (tenant, name)', () => {
    const { factory } = memoryFactory();
    const host = new WorkerHost(factory);
    host.start(SPEC);
    expect(() => host.start(SPEC)).toThrow(/already running/);
  });

  it('allows the same module name under a DIFFERENT tenant', () => {
    const { factory } = memoryFactory();
    const host = new WorkerHost(factory);
    host.start(SPEC);
    expect(() => host.start({ ...SPEC, tenantId: 't2' })).not.toThrow();
    expect(host.list()).toHaveLength(2);
  });

  it('routes a worker→core request to the registered broker handler', async () => {
    const mem = memoryFactory();
    const host = new WorkerHost(mem.factory, (peer) => peer.handle('whoami', () => 'broker'));
    host.start(SPEC);
    // Drive a request from the worker side via a peer on the stashed worker end.
    const workerPeer = new RpcPeer(mem.workerEnd('t1', 'wishlist'));
    await expect(workerPeer.request('whoami', null)).resolves.toBe('broker');
    workerPeer.dispose();
  });

  it('stop() tears down a running worker', () => {
    const { factory } = memoryFactory();
    const stopped: Array<[WorkerIdentity, string]> = [];
    const host = new WorkerHost(factory, undefined, {
      onStopped: (id, reason) => stopped.push([id, reason]),
    });
    host.start(SPEC);
    host.stop('t1', 'wishlist');
    expect(host.get('t1', 'wishlist')).toBeUndefined();
    expect(stopped).toEqual([[{ tenantId: 't1', name: 'wishlist' }, 'stopped']]);
  });

  it('CRASH ISOLATION: a worker channel closing drops it as "crash" without throwing', () => {
    const mem = memoryFactory();
    const stopped: Array<[WorkerIdentity, string]> = [];
    const host = new WorkerHost(mem.factory, undefined, {
      onStopped: (id, reason) => stopped.push([id, reason]),
    });
    host.start(SPEC);
    // Simulate the worker process dying: close the worker end of the channel.
    expect(() => mem.workerEnd('t1', 'wishlist').close()).not.toThrow();
    expect(host.get('t1', 'wishlist')).toBeUndefined();
    expect(stopped).toEqual([[{ tenantId: 't1', name: 'wishlist' }, 'crash']]);
    // The host is still usable — a fresh start of the same worker is allowed after a crash.
    expect(() => host.start(SPEC)).not.toThrow();
  });

  it('shutdown() stops every worker', () => {
    const { factory } = memoryFactory();
    const host = new WorkerHost(factory);
    host.start(SPEC);
    host.start({ ...SPEC, name: 'reviews' });
    host.shutdown();
    expect(host.list()).toHaveLength(0);
  });

  it('shutdown() fires onStopped for EVERY worker (so the bus is pruned on graceful exit)', () => {
    const { factory } = memoryFactory();
    const stopped: Array<[WorkerIdentity, string]> = [];
    const host = new WorkerHost(factory, undefined, {
      onStopped: (id, reason) => stopped.push([id, reason]),
    });
    host.start(SPEC);
    host.start({ ...SPEC, name: 'reviews' });
    host.shutdown();
    expect(stopped).toEqual(
      expect.arrayContaining([
        [{ tenantId: 't1', name: 'wishlist' }, 'stopped'],
        [{ tenantId: 't1', name: 'reviews' }, 'stopped'],
      ]),
    );
    expect(stopped).toHaveLength(2);
  });

  it('stop() fires onStopped EXACTLY once (no double-fire after the teardown refactor)', () => {
    const { factory } = memoryFactory();
    const stopped: Array<[WorkerIdentity, string]> = [];
    const host = new WorkerHost(factory, undefined, {
      onStopped: (id, reason) => stopped.push([id, reason]),
    });
    host.start(SPEC);
    host.stop('t1', 'wishlist');
    expect(stopped).toEqual([[{ tenantId: 't1', name: 'wishlist' }, 'stopped']]);
  });
});
