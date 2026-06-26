/**
 * events end-to-end integration.
 *
 * Proves the full path through the REAL app: a core domain event emitted on EventEmitter2 →
 * ModuleEventListener (@OnEvent) → ModuleEventBus → delivered (tenant-scoped) to a subscribed
 * worker's peer. Uses an in-memory peer to stand in for a running worker (no fork needed).
 */
import { EventEmitter2 } from '@nestjs/event-emitter';

import { bootAuthApp, teardownAuthApp, AuthHarness } from '../auth/_auth-harness';
import { ProductCreatedEvent } from '../../../src/catalog/events/product-created.event';
import { ModuleEventBus } from '../../../src/modules/runtime/module-event-bus';
import { RpcPeer } from '../../../src/modules/runtime/rpc';
import { createInMemoryChannelPair } from '../../../src/modules/runtime/worker-channel';
import { EVENTS_DELIVER_METHOD } from '../../../src/modules/runtime/module-events';

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('Module events end-to-end (integration)', () => {
  let h: AuthHarness;
  let emitter: EventEmitter2;
  let bus: ModuleEventBus;

  beforeAll(async () => {
    h = await bootAuthApp();
    emitter = h.app.get(EventEmitter2);
    bus = h.app.get(ModuleEventBus);
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });

  it('a core ProductCreatedEvent is delivered to a subscribed worker (tenant-scoped)', async () => {
    const [core, worker] = createInMemoryChannelPair();
    const corePeer = new RpcPeer(core, { requestTimeoutMs: 500 });
    const workerPeer = new RpcPeer(worker, { requestTimeoutMs: 500 });
    const received: Array<{ event: string; payload: unknown }> = [];
    workerPeer.handle(EVENTS_DELIVER_METHOD, (p) => {
      received.push(p as { event: string; payload: unknown });
      return { ok: true };
    });
    bus.subscribe('tenant-A', 'wishlist', corePeer, ['product.created']);

    // The real domain event flows: emitter → @OnEvent listener → bus → worker.
    emitter.emit(
      ProductCreatedEvent.EVENT,
      new ProductCreatedEvent('tenant-A', 'p1', 'Pen', 'active'),
    );
    await tick();
    expect(received).toEqual([{ event: 'product.created', payload: { productId: 'p1' } }]);

    // a different tenant's event is NOT delivered to this worker.
    emitter.emit(
      ProductCreatedEvent.EVENT,
      new ProductCreatedEvent('tenant-B', 'p2', 'Pad', 'active'),
    );
    await tick();
    expect(received).toHaveLength(1);

    bus.unsubscribe('tenant-A', 'wishlist');
    corePeer.dispose();
    workerPeer.dispose();
  });
});
