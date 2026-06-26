/**
 * the module-side SDK IMPLEMENTATION: the public
 * face of the broker that runs INSIDE the worker. Each method is a thin RPC stub over the
 * worker's {@link RpcPeer} — never a Drizzle/pg handle. All permission/tenant/refusal enforcement
 * lives in the broker (core side), so a module cannot disable it.
 *
 * the {@link ModuleSdk} capability INTERFACES (and the
 * `StoreClient`/`AdminClient`/… contracts) were EXTRACTED into `@sovecom/module-sdk` — the single
 * source of truth that the published author SDK and this in-tree implementation both consume. The
 * dependency direction is reversed: this file IMPLEMENTS the package's exported contract, and a
 * compile-time conformance check (`worker-sdk.type-test.ts`) guards that `createModuleSdk`'s
 * return type still satisfies it. The interfaces are re-exported here so existing in-tree
 * importers keep their `./worker-sdk` path.
 */
import type {
  ModuleSdk,
  StoreClient,
  AdminClient,
  CommerceClient,
  HttpClient,
  TablesClient,
  EventsClient,
  EmailClient,
  ModuleHttpRequest,
} from '@sovecom/module-sdk';
import type { RpcPeer } from './rpc';
import { MODULE_HTTP_METHOD } from './module-http';
import { EVENTS_DELIVER_METHOD } from './module-events';

export type {
  ModuleSdk,
  StoreClient,
  AdminClient,
  CommerceClient,
  HttpClient,
  TablesClient,
  EventsClient,
  EmailClient,
};

/** Build the module-side SDK over a worker peer. Each method is one typed broker RPC. */
export function createModuleSdk(peer: RpcPeer): ModuleSdk {
  const call = <T>(method: string, params: unknown): Promise<T> =>
    peer.request(method, params) as Promise<T>;

  // Liveness ping: core sends `ping`, a healthy worker answers `'pong'`.
  // A worker stuck in a synchronous loop cannot respond → core detects and stops it.
  peer.handle('ping', () => 'pong');

  // Worker-side event handlers, dispatched when core delivers an event.
  const eventHandlers = new Map<string, (payload: unknown) => void | Promise<void>>();
  peer.handle(EVENTS_DELIVER_METHOD, async (params) => {
    const { event, payload } = (params ?? {}) as { event?: string; payload?: unknown };
    const handler = event ? eventHandlers.get(event) : undefined;
    if (handler) await handler(payload);
    return { ok: true };
  });

  return {
    store: {
      products: {
        list: (q = {}) => call('products.list', q),
        get: (id) => call('products.get', { id }),
      },
      categories: {
        list: (q = {}) => call('categories.list', q),
        get: (id) => call('categories.get', { id }),
      },
    },
    admin: {
      orders: {
        list: (q = {}) => call('orders.list', q),
        get: (id) => call('orders.get', { id }),
      },
      customers: {
        list: (q = {}) => call('customers.list', q),
        get: (id) => call('customers.get', { id }),
      },
    },
    commerce: {
      hasPurchased: (customerId, productId) =>
        call('commerce.hasPurchased', { customerId, productId }),
    },
    http: {
      fetch: (request) => call('http.fetch', request),
    },
    tables: {
      query: (sql, params = []) => call('tables.query', { sql, params }),
      exec: (sql, params = []) => call('tables.exec', { sql, params }),
    },
    events: {
      on: (event, handler) => {
        eventHandlers.set(event, handler);
        return call('events.subscribe', { events: [...eventHandlers.keys()] });
      },
      emit: (event, payload) => call('events.emit', { event, payload }),
    },
    email: {
      send: (message) => call('email.send', message),
      sendToCustomer: (message) => call('email.sendToCustomer', message),
    },
    serve: (handler) => {
      peer.handle(MODULE_HTTP_METHOD, (params) => handler(params as ModuleHttpRequest));
    },
  };
}
