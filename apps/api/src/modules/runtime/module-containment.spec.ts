/**
 * END-TO-END containment matrix (Threat Model §6) against a REAL fork.
 *
 * Forks the `module-probe.cjs` fixture as a real OS process under the sandbox, wires a REAL
 * ModuleBroker on the core side, and asserts the probe was contained across the trust boundary:
 *   - filesystem escape blocked by the Node Permission Model;
 *   - a GRANTED read reaches core data through the broker;
 *   - an UNGRANTED read is FORBIDDEN; a core-table write is FORBIDDEN by design;
 *   - the worker never saw DB credentials (scrubbed env).
 */
import * as path from 'path';

import { RpcPeer } from './rpc';
import { ForkedWorkerChannel } from './forked-worker-channel';
import { ModuleBroker, type BrokerContext } from './module-broker';
import type { BrokerReadPorts } from './broker-ports';

const FIXTURE = path.resolve(__dirname, '../../../test/fixtures/runtime/module-probe.cjs');
const FIXTURE_DIR = path.dirname(FIXTURE);

function ports(): BrokerReadPorts {
  const empty = { list: () => Promise.resolve({ items: [] }), get: () => Promise.resolve(null) };
  return {
    products: {
      list: () =>
        Promise.resolve({ items: [{ id: 'p1', slug: 'p', title: 'Pen', status: 'active' }] }),
      get: () => Promise.resolve(null),
    },
    categories: empty,
    orders: empty,
    customers: empty,
  } as unknown as BrokerReadPorts;
}

describe('module containment (real fork + real broker)', () => {
  let channel: ForkedWorkerChannel;
  let peer: RpcPeer;

  afterEach(async () => {
    peer?.dispose();
    channel?.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('contains a probing module across the full §6 matrix', async () => {
    channel = new ForkedWorkerChannel({
      entry: FIXTURE,
      allowFsRead: [FIXTURE_DIR], // only its own dir — /etc/hosts is outside
      allowFsWrite: [],
      env: { SOVECOM_MODULE: 'probe' }, // scrubbed: no DB/secret creds
      maxOldSpaceMb: 128,
    });
    peer = new RpcPeer(channel);
    const egress = { fetch: () => Promise.reject(new Error('no egress in this test')) };
    const executor = {
      exec: () => Promise.reject(new Error('no tables in this test')),
    } as unknown as import('./module-sql.executor').ModuleSqlExecutor;
    const ctx: BrokerContext = {
      tenantId: 't1',
      moduleName: 'probe',
      grantedPermissions: new Set(['read:products']), // NOT read:orders
      httpAllowlist: new Set(),
    };
    const eventBus = {
      subscribe() {},
      emitModuleEvent() {},
      deliverCoreEvent() {},
      unsubscribe() {},
    } as unknown as import('./module-event-bus').ModuleEventBus;
    const mail = {
      send: () => Promise.reject(new Error('no email in this test')),
    } as unknown as import('./module-mail.port').ModuleMailPort;
    new ModuleBroker(ports(), egress, executor, eventBus, mail).registerOn(peer, ctx);

    // The probe sends its findings as a single `__report__` frame (the peer ignores it as an
    // unknown correlation id, so we capture it with a raw channel listener).
    const report = await new Promise<Record<string, unknown>>((resolve) => {
      channel.onMessage((raw) => {
        const f = raw as { kind?: string; id?: string; result?: Record<string, unknown> };
        if (f.kind === 'res' && f.id === '__report__' && f.result) resolve(f.result);
      });
    });

    // Filesystem escape was blocked (not READ_OK).
    expect(report.fsEscape).not.toBe('READ_OK');
    // Granted read reached core data through the broker.
    expect(report.productsOk).toBe(true);
    expect(report.productsCount).toBe(1);
    // Ungranted read + core write were both forbidden.
    expect(report.ordersErrorCode).toBe('forbidden');
    expect(report.writeErrorCode).toBe('forbidden');
    // No DB creds ever reached the worker.
    expect(report.hasDbUrl).toBe(false);
  }, 15000);
});
