/**
 * ModulesProxyController request-shaping unit tests.
 *
 * The security-critical guarantee of this chunk is that the module NEVER sees the caller's
 * credentials and CANNOT influence `surface`/`tenantId`. These tests capture the ModuleHttpRequest
 * the controller hands to the runtime and assert exactly that.
 */
import type { Request, Response } from 'express';

import { ModulesProxyController } from './modules-proxy.controller';
import type { ModuleRuntimeService } from './runtime/module-runtime.service';
import type { StoreTenantService } from '../catalog/store-tenant.service';
import type { ModuleHttpRequest } from './runtime/module-http';
import type { AuthenticatedUser } from '../auth/authenticated-user';

function fakeRes(): Response {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    send(b: unknown) {
      this.body = b;
    },
    json(b: unknown) {
      this.body = b;
    },
  };
  return res as unknown as Response;
}

function fakeReq(over: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    query: { q: '1' },
    headers: {
      authorization: 'Bearer SECRET-TOKEN',
      cookie: 'session=abc',
      'x-setup-token': 'setup-secret',
      host: 'api.internal',
      'content-type': 'application/json',
      'x-custom': 'keep-me',
    },
    body: { hello: 'world' },
    ...over,
  } as unknown as Request;
}

describe('ModulesProxyController request shaping', () => {
  let captured: { name: string; req: ModuleHttpRequest } | undefined;
  let controller: ModulesProxyController;

  beforeEach(() => {
    captured = undefined;
    const runtime = {
      handleHttp: (name: string, req: ModuleHttpRequest) => {
        captured = { name, req };
        return Promise.resolve({ status: 200, headers: {}, body: 'ok' });
      },
    } as unknown as ModuleRuntimeService;
    const storeTenant = {
      getDefaultTenantId: () => Promise.resolve('default-tenant'),
    } as unknown as StoreTenantService;
    controller = new ModulesProxyController(runtime, storeTenant);
  });

  it('STORE: strips caller credentials, sets surface=store + the default tenant', async () => {
    await controller.store('wishlist', ['items', '42'], fakeReq(), fakeRes());
    expect(captured!.name).toBe('wishlist');
    const { headers, surface, tenantId, path, method } = captured!.req;
    expect(surface).toBe('store');
    expect(tenantId).toBe('default-tenant');
    expect(path).toBe('/items/42');
    expect(method).toBe('POST');
    // credentials NEVER forwarded
    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
    expect(headers['x-setup-token']).toBeUndefined();
    expect(headers.host).toBeUndefined();
    // benign headers kept
    expect(headers['x-custom']).toBe('keep-me');
    expect(headers['content-type']).toBe('application/json');
  });

  it('ADMIN: sets surface=admin + the JWT tenant (never from request input)', async () => {
    const user = { tenantId: 'tenant-A' } as AuthenticatedUser;
    await controller.admin('wishlist', ['x'], user, fakeReq(), fakeRes());
    expect(captured!.req.surface).toBe('admin');
    expect(captured!.req.tenantId).toBe('tenant-A');
    expect(captured!.req.headers.authorization).toBeUndefined();
  });

  it('rejects a non-slug module name with 404 before proxying', async () => {
    const res = fakeRes();
    await controller.store('../etc', ['passwd'], fakeReq(), res);
    expect((res as unknown as { statusCode: number }).statusCode).toBe(404);
    expect(captured).toBeUndefined();
  });

  it('serializes a JSON body to a string for the module', async () => {
    await controller.store('wishlist', [''], fakeReq(), fakeRes());
    expect(captured!.req.body).toBe(JSON.stringify({ hello: 'world' }));
  });

  // ── verified-customer-identity bridge ───────────────────────────────────────
  describe('customer principal injection (anti-spoof)', () => {
    it('STORE: injects ONLY the guard-verified principal as { id } (the raw token is NOT forwarded)', async () => {
      // The StoreModuleCustomerAuthGuard ran before the handler and attached the DB-sourced
      // principal to req.customer. The proxy must surface exactly { id } to the module.
      const req = fakeReq({
        customer: {
          id: 'cust-verified-1',
          tenantId: 'default-tenant',
          email: 'v@x.test',
          name: 'V',
          isB2b: false,
        },
      } as never);
      await controller.store('wishlist', ['me'], req, fakeRes());
      expect(captured!.req.customer).toEqual({ id: 'cust-verified-1' });
      // token still stripped — the module never sees raw creds
      expect(captured!.req.headers.authorization).toBeUndefined();
      expect(captured!.req.headers.cookie).toBeUndefined();
    });

    it('STORE: anonymous (no req.customer) → customer is undefined, call still proceeds', async () => {
      await controller.store('wishlist', ['me'], fakeReq(), fakeRes());
      expect(captured).toBeDefined();
      expect(captured!.req.customer).toBeUndefined();
    });

    it('STORE: a client-supplied `customer` in the BODY cannot spoof the principal (ignored)', async () => {
      // No verified req.customer, but the attacker stuffs a customer into the JSON body.
      const req = fakeReq({ body: { customer: { id: 'attacker' }, hello: 'world' } });
      await controller.store('wishlist', ['me'], req, fakeRes());
      // The injected principal comes ONLY from req.customer (absent here) → undefined.
      expect(captured!.req.customer).toBeUndefined();
    });

    it('STORE: a client-supplied `customer` in the QUERY cannot spoof the principal (ignored)', async () => {
      const req = fakeReq({ query: { customer: 'attacker', q: '1' } as never });
      await controller.store('wishlist', ['me'], req, fakeRes());
      expect(captured!.req.customer).toBeUndefined();
    });

    it('STORE: a forged `x-customer-id` HEADER cannot spoof the principal (ignored)', async () => {
      const req = fakeReq({
        headers: { 'x-customer-id': 'attacker', 'content-type': 'application/json' } as never,
      });
      await controller.store('wishlist', ['me'], req, fakeRes());
      expect(captured!.req.customer).toBeUndefined();
    });

    it('STORE: a forged body `customer` does NOT override the guard-verified principal', async () => {
      // Both present: the verified principal wins; the body field is inert.
      const req = fakeReq({
        body: { customer: { id: 'attacker' } },
        customer: {
          id: 'cust-real',
          tenantId: 'default-tenant',
          email: 'r@x.test',
          name: 'R',
          isB2b: false,
        },
      } as never);
      await controller.store('wishlist', ['me'], req, fakeRes());
      expect(captured!.req.customer).toEqual({ id: 'cust-real' });
    });

    it('ADMIN: never carries a customer principal (admin surface is staff, not a buyer)', async () => {
      const user = { tenantId: 'tenant-A' } as AuthenticatedUser;
      // even if some upstream attached req.customer, the admin mount does not run the customer
      // guard; here req has none, so it's undefined.
      await controller.admin('wishlist', ['x'], user, fakeReq(), fakeRes());
      expect(captured!.req.customer).toBeUndefined();
    });
  });
});
