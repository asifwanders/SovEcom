/**
 * i.5 — verified-customer-identity bridge into the STORE module proxy (integration).
 *
 * SECURITY-CRITICAL. Against a REAL Postgres + the REAL Nest app (real StoreModuleCustomerAuthGuard,
 * real ModulesProxyController, real ModuleRuntimeService + WorkerHost), proves the seam end-to-end:
 *
 *   - an authenticated customer call → the module sees the VERIFIED `customer.id`;
 *   - a forged `customer` field (body/query/header) does NOT change it;
 *   - two different customers are ISOLATED (each sees only their own id);
 *   - an anonymous call → `customer` is absent (the call still reaches the module);
 *   - a PRESENTED-but-bad token → 401 (never silently downgraded to anonymous);
 *   - the raw `authorization`/`cookie` are still stripped — the module never sees the token.
 *
 * Rather than fork a real sandboxed worker (heavy; needs a fixture module on disk), we register an
 * IN-MEMORY worker into the REAL WorkerHost via its OWN `start()` lifecycle, with the channel
 * factory swapped to an in-memory channel pair. Everything the bridge touches — the guard, the JWT
 * verification against the DB, the proxy's request shaping, the tenant resolution, and the
 * host's worker lookup — is the production code path; only the worker transport is in-memory. The
 * fixture handler echoes back exactly what core handed it (`customer`, stripped headers) so the
 * test asserts what the module ACTUALLY observed, not merely what core intended to send.
 */
import request from 'supertest';

import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  signupAndLogin,
  DEFAULT_TENANT_ID,
  type CustomersHarness,
} from '../customers/_customers-harness';
import { WorkerHost } from '../../../src/modules/runtime/worker-host';
import { RpcPeer } from '../../../src/modules/runtime/rpc';
import { createInMemoryChannelPair } from '../../../src/modules/runtime/worker-channel';
import { createModuleSdk } from '../../../src/modules/runtime/worker-sdk';
import type {
  ModuleHttpHandler,
  ModuleHttpRequest,
} from '../../../src/modules/runtime/module-http';

const MODULE = 'wishlist';

/** Swap the real WorkerHost's channel factory so `start()` wires an in-memory worker we control. */
type HostWithFactory = WorkerHost & {
  channelFactory: (spec: { tenantId: string; name: string }) => unknown;
};

describe('STORE module proxy — verified customer identity (integration)', () => {
  let h: CustomersHarness;
  let host: WorkerHost;
  let originalFactory: HostWithFactory['channelFactory'];
  let lastSeen: ModuleHttpRequest | undefined;
  let workerPeer: RpcPeer | undefined;

  beforeAll(async () => {
    h = await bootCustomersApp();
    host = h.app.get(WorkerHost);
    originalFactory = (host as HostWithFactory).channelFactory;
  });

  afterAll(async () => {
    (host as HostWithFactory).channelFactory = originalFactory;
    await teardownCustomersApp(h);
  });

  beforeEach(async () => {
    await resetCustomersState(h);
    lastSeen = undefined;
    startEchoWorker((req) => {
      lastSeen = req;
    });
  });

  afterEach(() => {
    host.stop(DEFAULT_TENANT_ID, MODULE);
    workerPeer?.dispose();
    workerPeer = undefined;
  });

  /**
   * Start an in-memory worker for (DEFAULT_TENANT_ID, MODULE) through the host's OWN `start()`.
   * The SDK-served handler records the request the module RECEIVED and echoes it back (so the
   * response body proves what the module saw — `customer`, stripped headers — not just what core
   * sent over the wire).
   */
  function startEchoWorker(onReq: (req: ModuleHttpRequest) => void): void {
    const handler: ModuleHttpHandler = (req) => {
      onReq(req);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          customer: req.customer ?? null,
          hasAuthHeader: 'authorization' in req.headers,
          hasCookieHeader: 'cookie' in req.headers,
        }),
      };
    };
    (host as HostWithFactory).channelFactory = () => {
      const [core, worker] = createInMemoryChannelPair();
      workerPeer = new RpcPeer(worker, { requestTimeoutMs: 2000 });
      createModuleSdk(workerPeer).serve(handler);
      return core;
    };
    host.start({
      tenantId: DEFAULT_TENANT_ID,
      name: MODULE,
      entry: 'in-memory',
      allowFsRead: [],
      allowFsWrite: [],
    });
  }

  it('authenticated customer → the module sees the VERIFIED customer.id (token NOT forwarded)', async () => {
    const cust = await signupAndLogin(h);
    const res = await request(h.http())
      .get(`/store/v1/modules/${MODULE}/me`)
      .set('Authorization', `Bearer ${cust.accessToken}`)
      .expect(200);

    expect(res.body.customer).toEqual({ id: cust.customerId });
    expect(lastSeen!.customer).toEqual({ id: cust.customerId });
    // the raw token / cookie never reach the module
    expect(res.body.hasAuthHeader).toBe(false);
    expect(res.body.hasCookieHeader).toBe(false);
    expect(lastSeen!.headers.authorization).toBeUndefined();
  });

  it('anonymous call → customer is ABSENT, the call still reaches the module (200)', async () => {
    const res = await request(h.http()).get(`/store/v1/modules/${MODULE}/me`).expect(200);
    expect(res.body.customer).toBeNull();
    expect(lastSeen!.customer).toBeUndefined();
  });

  it('a forged `customer` in BODY/QUERY does NOT change the verified principal (anonymous stays anonymous)', async () => {
    const res = await request(h.http())
      .post(`/store/v1/modules/${MODULE}/me?customer=attacker`)
      .set('Content-Type', 'application/json')
      .send({ customer: { id: 'attacker' } })
      .expect(200);
    // No valid token presented → no verified principal → forged field is inert.
    expect(res.body.customer).toBeNull();
    expect(lastSeen!.customer).toBeUndefined();
  });

  it('a forged body `customer` cannot OVERRIDE a genuine verified principal', async () => {
    const cust = await signupAndLogin(h);
    const res = await request(h.http())
      .post(`/store/v1/modules/${MODULE}/me`)
      .set('Authorization', `Bearer ${cust.accessToken}`)
      .set('Content-Type', 'application/json')
      .send({ customer: { id: 'attacker' } })
      .expect(200);
    expect(res.body.customer).toEqual({ id: cust.customerId });
  });

  it('two different customers are ISOLATED — each module call sees only its own id', async () => {
    const a = await signupAndLogin(h);
    const b = await signupAndLogin(h);
    expect(a.customerId).not.toBe(b.customerId);

    const resA = await request(h.http())
      .get(`/store/v1/modules/${MODULE}/me`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(resA.body.customer).toEqual({ id: a.customerId });

    const resB = await request(h.http())
      .get(`/store/v1/modules/${MODULE}/me`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(resB.body.customer).toEqual({ id: b.customerId });
  });

  it('a PRESENTED-but-bad token → 401 (never reaches the module, never downgraded to anonymous)', async () => {
    await request(h.http())
      .get(`/store/v1/modules/${MODULE}/me`)
      .set('Authorization', 'Bearer not-a-valid-jwt')
      .expect(401);
    expect(lastSeen).toBeUndefined(); // the guard rejected before the proxy ran
  });

  it('a stale token (after a token_version bump = session kill) → 401', async () => {
    const cust = await signupAndLogin(h);
    // Bump the customer's token_version out from under the still-valid access token.
    await h.client`
      update customers set token_version = token_version + 1 where id = ${cust.customerId}
    `;
    await request(h.http())
      .get(`/store/v1/modules/${MODULE}/me`)
      .set('Authorization', `Bearer ${cust.accessToken}`)
      .expect(401);
    expect(lastSeen).toBeUndefined();
  });
});
