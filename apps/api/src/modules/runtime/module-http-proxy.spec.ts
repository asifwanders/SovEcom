/**
 * ModuleRuntimeService.handleHttp + worker-SDK serve unit tests.
 *
 * A module registers an HTTP handler via the SDK; core proxies a request to it over a real RPC
 * pair (in-memory). Pins: the round-trip works; 404 when the module isn't running; and the
 * UNTRUSTED worker response is bounded (status clamp, header allowlist, body cap).
 */
import { NotFoundException } from '@nestjs/common';

import { RpcPeer } from './rpc';
import { createInMemoryChannelPair } from './worker-channel';
import { createModuleSdk } from './worker-sdk';
import { ModuleRuntimeService } from './module-runtime.service';
import {
  MAX_MODULE_RESPONSE_BYTES,
  type ModuleHttpHandler,
  type ModuleHttpRequest,
} from './module-http';
import type { WorkerHost, WorkerHandle } from './worker-host';

function runtimeWithWorker(handler: ModuleHttpHandler, status: 'running' | 'stopped' = 'running') {
  const [core, worker] = createInMemoryChannelPair();
  const corePeer = new RpcPeer(core, { requestTimeoutMs: 1000 });
  const workerPeer = new RpcPeer(worker, { requestTimeoutMs: 1000 });
  createModuleSdk(workerPeer).serve(handler);
  const handle = {
    identity: { tenantId: 't1', name: 'wishlist' },
    peer: corePeer,
    status,
    startedAt: 0,
  } as WorkerHandle;
  const host = {
    get: (t: string, n: string) => (t === 't1' && n === 'wishlist' ? handle : undefined),
  } as unknown as WorkerHost;
  // Only `host` is exercised by handleHttp; the other deps are unused here.
  const svc = new ModuleRuntimeService({} as never, host, {} as never, {} as never, {} as never);
  return { svc, dispose: () => (corePeer.dispose(), workerPeer.dispose()) };
}

const REQ: ModuleHttpRequest = {
  surface: 'store',
  tenantId: 't1',
  method: 'GET',
  path: '/items',
  query: {},
  headers: {},
};

describe('ModuleRuntimeService.handleHttp + sdk.serve', () => {
  it('proxies a request to the module handler and returns its response', async () => {
    const { svc, dispose } = runtimeWithWorker((req) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: req.path, tenant: req.tenantId }),
    }));
    const res = await svc.handleHttp('wishlist', REQ);
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(res.body!)).toEqual({ path: '/items', tenant: 't1' });
    dispose();
  });

  it('404s when the module is not running', async () => {
    const { svc, dispose } = runtimeWithWorker(() => ({ status: 200 }), 'stopped');
    await expect(svc.handleHttp('wishlist', REQ)).rejects.toBeInstanceOf(NotFoundException);
    dispose();
  });

  it('404s when there is no worker for the module', async () => {
    const { svc, dispose } = runtimeWithWorker(() => ({ status: 200 }));
    await expect(svc.handleHttp('ghost', REQ)).rejects.toBeInstanceOf(NotFoundException);
    dispose();
  });

  it('bounds an untrusted response: clamps an invalid status to 502', async () => {
    const { svc, dispose } = runtimeWithWorker(() => ({ status: 999, body: 'x' }));
    expect((await svc.handleHttp('wishlist', REQ)).status).toBe(502);
    dispose();
  });

  it('drops disallowed response headers (set-cookie, x-evil) and keeps the allowlist', async () => {
    const { svc, dispose } = runtimeWithWorker(() => ({
      status: 200,
      headers: {
        'set-cookie': 'sid=1',
        'x-evil': 'y',
        'content-type': 'text/plain',
        'cache-control': 'no-store',
      },
    }));
    const res = await svc.handleHttp('wishlist', REQ);
    expect(res.headers).toEqual({ 'content-type': 'text/plain', 'cache-control': 'no-store' });
    dispose();
  });

  it('rejects an oversize response body with 502', async () => {
    const big = 'x'.repeat(MAX_MODULE_RESPONSE_BYTES + 1);
    const { svc, dispose } = runtimeWithWorker(() => ({ status: 200, body: big }));
    expect((await svc.handleHttp('wishlist', REQ)).status).toBe(502);
    dispose();
  });

  it('coerces an active/unknown content-type to octet-stream (no HTML render on the API origin)', async () => {
    const { svc, dispose } = runtimeWithWorker(() => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<script>alert(1)</script>',
    }));
    expect((await svc.handleHttp('wishlist', REQ)).headers!['content-type']).toBe(
      'application/octet-stream',
    );
    dispose();
  });

  it('defaults a missing content-type to octet-stream', async () => {
    const { svc, dispose } = runtimeWithWorker(() => ({ status: 200, body: 'hi' }));
    expect((await svc.handleHttp('wishlist', REQ)).headers!['content-type']).toBe(
      'application/octet-stream',
    );
    dispose();
  });

  it('keeps a safe content-type (application/json; charset) and drops a CRLF-injected header', async () => {
    const { svc, dispose } = runtimeWithWorker(() => ({
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'x\r\nSet-Cookie: sid=1',
      },
    }));
    const res = await svc.handleHttp('wishlist', REQ);
    expect(res.headers!['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers!['cache-control']).toBeUndefined(); // CRLF value dropped
    dispose();
  });
});
