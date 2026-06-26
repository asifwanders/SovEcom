/**
 * write:own_tables end-to-end (broker → executor → DB) integration.
 *
 * Drives the broker's tables.query/exec over a real RPC peer against a REAL provisioned module
 * schema, proving the full path: a module with write:own_tables can CRUD its OWN tables, but a
 * tables.* statement that targets a core table is refused by the DB (role isolation), and without
 * the permission the broker refuses before touching the DB.
 */
import { bootAuthApp, teardownAuthApp, AuthHarness } from '../auth/_auth-harness';
import { DatabaseService } from '../../../src/database/database.service';
import { ModuleDbProvisioner } from '../../../src/modules/runtime/module-db.provisioner';
import { ModuleSqlExecutor } from '../../../src/modules/runtime/module-sql.executor';
import { RpcPeer } from '../../../src/modules/runtime/rpc';
import { RpcErrorCode } from '../../../src/modules/runtime/ipc-protocol';
import { createInMemoryChannelPair } from '../../../src/modules/runtime/worker-channel';
import { ModuleBroker, type BrokerContext } from '../../../src/modules/runtime/module-broker';
import type { BrokerReadPorts } from '../../../src/modules/runtime/broker-ports';

const MOD = 'itesttbl';

function emptyPorts(): BrokerReadPorts {
  const p = { list: () => Promise.resolve({ items: [] }), get: () => Promise.resolve(null) };
  return { products: p, categories: p, orders: p, customers: p } as unknown as BrokerReadPorts;
}

describe('write:own_tables end-to-end (integration)', () => {
  let h: AuthHarness;
  let provisioner: ModuleDbProvisioner;
  let executor: ModuleSqlExecutor;
  let corePeer: RpcPeer;
  let workerPeer: RpcPeer;

  beforeAll(async () => {
    h = await bootAuthApp();
    const db = h.app.get(DatabaseService);
    provisioner = new ModuleDbProvisioner(db);
    executor = new ModuleSqlExecutor(db);
    await provisioner.deprovision(MOD);
    await provisioner.provision(MOD);
    executor.open(MOD, await provisioner.rotateCredential(MOD));
    await executor.execDdl(MOD, 'CREATE TABLE notes (id int primary key, body text)');
  });

  afterAll(async () => {
    corePeer?.dispose();
    workerPeer?.dispose();
    await executor.close(MOD);
    await provisioner.deprovision(MOD).catch(() => undefined);
    await teardownAuthApp(h);
  });

  function wire(grants: string[]) {
    corePeer?.dispose();
    workerPeer?.dispose();
    const [core, worker] = createInMemoryChannelPair();
    corePeer = new RpcPeer(core, { requestTimeoutMs: 2000 });
    workerPeer = new RpcPeer(worker, { requestTimeoutMs: 2000 });
    const ctx: BrokerContext = {
      tenantId: 't1',
      moduleName: MOD,
      grantedPermissions: new Set(grants as never),
      httpAllowlist: new Set(),
    };
    new ModuleBroker(
      emptyPorts(),
      { fetch: () => Promise.reject(new Error('n/a')) },
      executor,
    ).registerOn(corePeer, ctx);
    return workerPeer;
  }

  it('a granted module CRUDs its OWN table through tables.*', async () => {
    const w = wire(['write:own_tables']);
    await w.request('tables.exec', {
      sql: 'INSERT INTO notes (id, body) VALUES ($1,$2)',
      params: [1, 'hi'],
    });
    const res = (await w.request('tables.query', {
      sql: 'SELECT id, body FROM notes ORDER BY id',
    })) as {
      rows: Array<{ id: number; body: string }>;
    };
    expect(res.rows).toEqual([{ id: 1, body: 'hi' }]);
  });

  it('a tables.* statement targeting a CORE table is refused by the DB', async () => {
    const w = wire(['write:own_tables']);
    await expect(
      w.request('tables.query', { sql: 'SELECT * FROM public.tenants' }),
    ).rejects.toMatchObject({ code: RpcErrorCode.HANDLER_ERROR }); // pg: permission denied
  });

  it('without write:own_tables, tables.* is FORBIDDEN before any DB call', async () => {
    const w = wire([]);
    await expect(w.request('tables.exec', { sql: 'SELECT 1' })).rejects.toMatchObject({
      code: RpcErrorCode.FORBIDDEN,
    });
  });
});
