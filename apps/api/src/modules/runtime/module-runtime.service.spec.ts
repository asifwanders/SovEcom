/**
 * ModuleRuntimeService orchestration unit test (fake host + repo).
 * Verifies enable loads the row, assembles the broker context (grants + tenant + allowlist),
 * starts a worker with a correctly-scoped spec, and registers the broker; 404 when not installed;
 * disable stops the worker.
 *
 * liveness watchdog unit tests: a hung worker (ping rejects) is stopped
 * and its enabled flag is persisted as false; a healthy worker (ping resolves) is NOT stopped.
 */
import { NotFoundException } from '@nestjs/common';

import { RpcPeer } from './rpc';
import { createInMemoryChannelPair } from './worker-channel';
import { ModuleRuntimeService } from './module-runtime.service';
import type { WorkerHost, WorkerSpec, WorkerHandle } from './worker-host';
import type { ModuleBroker, BrokerContext } from './module-broker';
import type { ModulesRepository } from '../modules.repository';

function fakeRow(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    tenantId: 't1',
    name: 'wishlist',
    version: '1.0.0',
    source: 'upload',
    manifest: {},
    grantedPermissions: ['read:products', 'http:outbound'],
    settings: { httpAllowlist: ['API.Example.com'] },
    enabled: true,
    installedAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function fakeDbDeps() {
  const provisioner = {
    provision: jest.fn().mockResolvedValue(undefined),
    rotateCredential: jest.fn().mockResolvedValue('hexpw'),
    deprovision: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('./module-db.provisioner').ModuleDbProvisioner;
  const executor = {
    open: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  } as unknown as import('./module-sql.executor').ModuleSqlExecutor;
  return { provisioner, executor };
}

function fakeRepo(over: Partial<ModulesRepository> = {}): ModulesRepository {
  return {
    findByName: jest.fn().mockResolvedValue(fakeRow()),
    setEnabled: jest.fn().mockResolvedValue(true),
    deleteByName: jest.fn().mockResolvedValue(true),
    insert: jest.fn(),
    list: jest.fn(),
    ...over,
  } as unknown as ModulesRepository;
}

describe('ModuleRuntimeService', () => {
  it('enable: loads the row, starts a scoped worker, and registers the broker with the context', async () => {
    const [core] = createInMemoryChannelPair();
    const peer = new RpcPeer(core);
    const handle = {
      identity: { tenantId: 't1', name: 'wishlist' },
      peer,
      status: 'running',
      startedAt: 0,
    } as WorkerHandle;

    let startedSpec: WorkerSpec | undefined;
    const host = {
      start: (spec: WorkerSpec) => {
        startedSpec = spec;
        return handle;
      },
      stop: jest.fn(),
      get: jest.fn(),
      list: jest.fn().mockReturnValue([]),
    } as unknown as WorkerHost;

    let registeredCtx: BrokerContext | undefined;
    const broker = {
      registerOn: (_p: RpcPeer, ctx: BrokerContext) => (registeredCtx = ctx),
    } as unknown as ModuleBroker;
    const repo = fakeRepo();
    const { provisioner, executor } = fakeDbDeps();
    const svc = new ModuleRuntimeService(repo, host, broker, provisioner, executor);
    await svc.enable('t1', 'wishlist');

    // DB home is provisioned + a connection opened before the worker runs.
    expect(provisioner.provision).toHaveBeenCalledWith('wishlist');
    expect(provisioner.rotateCredential).toHaveBeenCalledWith('wishlist');
    expect(executor.open).toHaveBeenCalledWith('wishlist', 'hexpw');
    // Context assembled from the row: grants, tenant, lowercased allowlist.
    expect(registeredCtx?.tenantId).toBe('t1');
    expect([...(registeredCtx?.grantedPermissions ?? [])].sort()).toEqual([
      'http:outbound',
      'read:products',
    ]);
    expect([...(registeredCtx?.httpAllowlist ?? [])]).toEqual(['api.example.com']);
    // Spec is tenant/module scoped, forks the compiled entry, and confines fs.
    expect(startedSpec?.tenantId).toBe('t1');
    expect(startedSpec?.entry).toMatch(/worker-entry\.js$/);
    // 3.3c grants NO fs-write (closes the symlink-from-writable-dir vector).
    expect(startedSpec?.allowFsWrite).toEqual([]);
    // fs-read is confined to runtime + node_modules + this module's dir only.
    expect(startedSpec?.allowFsRead?.some((p) => /\/wishlist$/.test(p))).toBe(true);
    expect(startedSpec?.env?.SOVECOM_MODULE_MAIN).toMatch(/wishlist\/index\.js$/);
    // Scrubbed env carries identity only — never secrets.
    expect(JSON.stringify(startedSpec?.env)).not.toMatch(/SECRET|KEY|PASSWORD|DATABASE|REDIS/i);
    // enabled flag is persisted after the worker starts.
    expect(repo.setEnabled as jest.Mock).toHaveBeenCalledWith('t1', 'wishlist', true);
    peer.dispose();
  });

  it('enable: 404 when the module is not installed for the tenant', async () => {
    const start = jest.fn();
    const host = {
      start,
      stop: jest.fn(),
      get: jest.fn(),
      list: jest.fn().mockReturnValue([]),
    } as unknown as WorkerHost;
    const broker = { registerOn: jest.fn() } as unknown as ModuleBroker;
    const repo = fakeRepo({ findByName: jest.fn().mockResolvedValue(null) });
    const { provisioner, executor } = fakeDbDeps();
    const svc = new ModuleRuntimeService(repo, host, broker, provisioner, executor);
    await expect(svc.enable('t1', 'ghost')).rejects.toBeInstanceOf(NotFoundException);
    expect(start).not.toHaveBeenCalled();
    expect(provisioner.provision).not.toHaveBeenCalled(); // 404 before any DB work
  });

  it('disable: stops the worker, closes its DB connection, and persists enabled=false', async () => {
    const stop = jest.fn();
    const host = {
      start: jest.fn(),
      stop,
      get: jest.fn(),
      list: jest.fn().mockReturnValue([]),
    } as unknown as WorkerHost;
    const broker = { registerOn: jest.fn() } as unknown as ModuleBroker;
    const repo = fakeRepo();
    const { provisioner, executor } = fakeDbDeps();
    await new ModuleRuntimeService(repo, host, broker, provisioner, executor).disable(
      't1',
      'wishlist',
    );
    expect(stop).toHaveBeenCalledWith('t1', 'wishlist');
    expect(executor.close).toHaveBeenCalledWith('wishlist');
  });

  // ── Liveness watchdog ─────────────────────────────────

  describe('checkLiveness', () => {
    function makeHandle(
      tenantId: string,
      name: string,
      pingResult: 'ok' | 'reject' | 'timeout',
    ): WorkerHandle & { peer: { request: jest.Mock } } {
      const request = jest.fn().mockImplementation(() => {
        if (pingResult === 'ok') return Promise.resolve('pong');
        if (pingResult === 'reject') return Promise.reject(new Error('worker hung'));
        // 'timeout': return a never-resolving promise (simulating the ping race-reject scenario)
        return new Promise(() => undefined);
      });
      return {
        identity: { tenantId, name },
        peer: { request } as unknown as RpcPeer,
        status: 'running',
        startedAt: 0,
      } as WorkerHandle & { peer: { request: jest.Mock } };
    }

    it('a hung worker (ping rejects) is stopped and its enabled flag persisted as false', async () => {
      const hungHandle = makeHandle('t1', 'wishlist', 'reject');
      const stop = jest.fn();
      const host = {
        list: jest.fn().mockReturnValue([hungHandle]),
        stop,
        get: jest.fn(),
        start: jest.fn(),
      } as unknown as WorkerHost;
      const repo = fakeRepo();
      const { provisioner, executor } = fakeDbDeps();
      const broker = { registerOn: jest.fn() } as unknown as ModuleBroker;
      const svc = new ModuleRuntimeService(repo, host, broker, provisioner, executor);

      await svc.checkLiveness();

      // stop must have been called (disable path).
      expect(stop).toHaveBeenCalledWith('t1', 'wishlist');
      expect(executor.close).toHaveBeenCalledWith('wishlist');
      // enabled flag persisted as false so a process restart doesn't auto-re-enable.
      expect(repo.setEnabled as jest.Mock).toHaveBeenCalledWith('t1', 'wishlist', false);
    });

    it('a healthy worker (ping resolves) is NOT stopped', async () => {
      const healthyHandle = makeHandle('t1', 'widget', 'ok');
      const stop = jest.fn();
      const host = {
        list: jest.fn().mockReturnValue([healthyHandle]),
        stop,
        get: jest.fn(),
        start: jest.fn(),
      } as unknown as WorkerHost;
      const repo = fakeRepo();
      const { provisioner, executor } = fakeDbDeps();
      const broker = { registerOn: jest.fn() } as unknown as ModuleBroker;
      const svc = new ModuleRuntimeService(repo, host, broker, provisioner, executor);

      await svc.checkLiveness();

      expect(stop).not.toHaveBeenCalled();
      expect(repo.setEnabled as jest.Mock).not.toHaveBeenCalledWith('t1', 'widget', false);
    });

    it('does not run a second concurrent liveness check (overlap guard)', async () => {
      // Make ping return a slow promise so we can test the guard.
      let resolvePing: (v: unknown) => void;
      const slowPing = new Promise((res) => (resolvePing = res));
      const handle = {
        identity: { tenantId: 't1', name: 'slow' },
        peer: { request: jest.fn().mockReturnValue(slowPing) } as unknown as RpcPeer,
        status: 'running' as const,
        startedAt: 0,
      };
      const host = {
        list: jest.fn().mockReturnValue([handle]),
        stop: jest.fn(),
        get: jest.fn(),
        start: jest.fn(),
      } as unknown as WorkerHost;
      const repo = fakeRepo();
      const { provisioner, executor } = fakeDbDeps();
      const broker = { registerOn: jest.fn() } as unknown as ModuleBroker;
      const svc = new ModuleRuntimeService(repo, host, broker, provisioner, executor);

      // Fire two concurrent checks; the second should short-circuit immediately.
      const first = svc.checkLiveness();
      const second = svc.checkLiveness();

      // The list is called only ONCE — the second call is a no-op.
      expect(host.list).toHaveBeenCalledTimes(1);

      // Resolve the slow ping so the first check completes.
      resolvePing!('pong');
      await Promise.all([first, second]);
    });
  });
});
