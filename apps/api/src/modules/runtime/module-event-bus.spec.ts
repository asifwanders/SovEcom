/**
 * ModuleEventBus unit tests (delivery, tenant scoping, validation).
 */
import { RpcPeer } from './rpc';
import { createInMemoryChannelPair } from './worker-channel';
import { ModuleEventBus } from './module-event-bus';
import { EVENTS_DELIVER_METHOD, MAX_EVENT_PAYLOAD_BYTES } from './module-events';
import { WorkerHost } from './worker-host';

/** A core-side peer + a worker-side peer that records delivered events. */
function workerOnBus(bus: ModuleEventBus, tenantId: string, moduleName: string, events: string[]) {
  const [core, worker] = createInMemoryChannelPair();
  const corePeer = new RpcPeer(core, { requestTimeoutMs: 500 });
  const workerPeer = new RpcPeer(worker, { requestTimeoutMs: 500 });
  const received: Array<{ event: string; payload: unknown }> = [];
  workerPeer.handle(EVENTS_DELIVER_METHOD, (p) => {
    received.push(p as { event: string; payload: unknown });
    return { ok: true };
  });
  bus.subscribe(tenantId, moduleName, corePeer, events);
  return { received, dispose: () => (corePeer.dispose(), workerPeer.dispose()) };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('ModuleEventBus', () => {
  it('delivers a subscribed core event to the worker (tenant-scoped)', async () => {
    const bus = new ModuleEventBus();
    const w = workerOnBus(bus, 't1', 'wishlist', ['order.paid']);
    bus.deliverCoreEvent('order.paid', 't1', { orderId: 'o1' });
    await tick();
    expect(w.received).toEqual([{ event: 'order.paid', payload: { orderId: 'o1' } }]);
    w.dispose();
  });

  it('does NOT deliver an event the worker did not subscribe to', async () => {
    const bus = new ModuleEventBus();
    const w = workerOnBus(bus, 't1', 'wishlist', ['order.paid']);
    bus.deliverCoreEvent('product.created', 't1', { productId: 'p1' });
    await tick();
    expect(w.received).toEqual([]);
    w.dispose();
  });

  it('does NOT deliver across tenants', async () => {
    const bus = new ModuleEventBus();
    const w = workerOnBus(bus, 't1', 'wishlist', ['order.paid']);
    bus.deliverCoreEvent('order.paid', 'other-tenant', { orderId: 'o1' });
    await tick();
    expect(w.received).toEqual([]);
    w.dispose();
  });

  it('rejects subscribing to a non-subscribable event', () => {
    const bus = new ModuleEventBus();
    const [core] = createInMemoryChannelPair();
    const peer = new RpcPeer(core);
    expect(() => bus.subscribe('t1', 'm', peer, ['payments.charge'])).toThrow(/subscribable/);
    expect(() => bus.subscribe('t1', 'm', peer, ['secret.read'])).toThrow(/subscribable/);
    peer.dispose();
  });

  it('emit: namespaces to mod.<from>.<event> and delivers to OTHER subscribed modules (not the emitter)', async () => {
    const bus = new ModuleEventBus();
    const emitter = workerOnBus(bus, 't1', 'sender', ['mod.sender.ping']); // also subscribed to its own
    const other = workerOnBus(bus, 't1', 'receiver', ['mod.sender.ping']);
    bus.emitModuleEvent('t1', 'sender', 'ping', { n: 1 });
    await tick();
    // delivered to the OTHER module, NOT echoed to the emitter
    expect(other.received).toEqual([{ event: 'mod.sender.ping', payload: { n: 1 } }]);
    expect(emitter.received).toEqual([]);
    emitter.dispose();
    other.dispose();
  });

  it('emit: refuses to forge a core event name', () => {
    const bus = new ModuleEventBus();
    expect(() => bus.emitModuleEvent('t1', 'sender', 'order.paid', {})).toThrow(
      /invalid module event/,
    );
  });

  it('emit: rejects an oversize payload', () => {
    const bus = new ModuleEventBus();
    const big = { blob: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES + 1) };
    expect(() => bus.emitModuleEvent('t1', 'sender', 'big', big)).toThrow(/too large/);
  });

  it('emit: rate-limits a burst of emits per worker (BUSY) — bounds the fan-out DoS', () => {
    const bus = new ModuleEventBus();
    // No subscribers needed — we exercise the per-emitter token bucket. A tight synchronous burst
    // sees ~0 elapsed (no refill), so it depletes the burst budget and the next emit is BUSY.
    let busy = 0;
    for (let i = 0; i < 200; i++) {
      try {
        bus.emitModuleEvent('t1', 'sender', 'ping', { i });
      } catch (e) {
        busy++;
        expect((e as { code?: string }).code).toBe('busy');
      }
    }
    expect(busy).toBeGreaterThan(0); // the burst was capped
    // A DIFFERENT emitter has its own bucket — not penalised by sender's burst.
    expect(() => bus.emitModuleEvent('t1', 'other', 'ping', {})).not.toThrow();
  });

  it('a worker stop prunes its bus subscription (host onStopped → unsubscribe wiring)', () => {
    const bus = new ModuleEventBus();
    const host = new WorkerHost(
      () => createInMemoryChannelPair()[0], // core end; worker end unused for this wiring test
      undefined,
      { onStopped: (id) => bus.unsubscribe(id.tenantId, id.name) },
    );
    const handle = host.start({
      tenantId: 't1',
      name: 'wishlist',
      entry: 'x',
      allowFsRead: [],
      allowFsWrite: [],
    });
    bus.subscribe('t1', 'wishlist', handle.peer, ['order.paid']);
    expect(bus.size).toBe(1);
    host.stop('t1', 'wishlist');
    expect(bus.size).toBe(0);
  });

  it('caps outbound in-flight deliveries to a SLOW subscriber (drops the excess)', async () => {
    const bus = new ModuleEventBus();
    // A peer whose `request` never resolves (slow subscriber that pings healthy but never acks).
    let calls = 0;
    const slowPeer = {
      request: jest.fn(() => {
        calls += 1;
        return new Promise(() => {}); // never resolves
      }),
      dispose: jest.fn(),
    } as unknown as RpcPeer;
    bus.subscribe('t1', 'slowmod', slowPeer, ['order.paid']);

    // Fan far more matching events than the cap; each opens one outbound request that never closes.
    for (let i = 0; i < 100; i++) {
      bus.deliverCoreEvent('order.paid', 't1', { i });
    }
    await tick();
    // Bounded by the per-subscriber in-flight cap (16), NOT 100.
    expect(calls).toBe(16);
    expect((slowPeer.request as jest.Mock).mock.calls.length).toBe(16);
  });

  it('unsubscribe stops delivery', async () => {
    const bus = new ModuleEventBus();
    const w = workerOnBus(bus, 't1', 'wishlist', ['order.paid']);
    bus.unsubscribe('t1', 'wishlist');
    expect(bus.size).toBe(0);
    bus.deliverCoreEvent('order.paid', 't1', { orderId: 'o1' });
    await tick();
    expect(w.received).toEqual([]);
    w.dispose();
  });
});
