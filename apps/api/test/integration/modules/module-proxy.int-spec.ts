/**
 * module endpoint mounting (proxy) integration.
 *
 * Exercises the mounted-route GATING end-to-end (no running worker needed — an un-enabled module
 * 404s after the gate): the STORE surface is public, the ADMIN surface needs the JWT + modules:use
 * (staff is fail-closed), and the proxy catch-all does NOT shadow the management routes.
 */
import request from 'supertest';

import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  AuthHarness,
  AUTH,
} from '../auth/_auth-harness';
import { systemState } from '../../../src/database/schema/system_state';

describe('Module endpoint proxy gating (integration)', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });
  beforeEach(async () => {
    await resetAuthState(h);
  });

  async function login(email: string, password: string): Promise<string> {
    const res = await request(h.http()).post(AUTH.login).send({ email, password }).expect(200);
    return res.body.accessToken as string;
  }

  it('STORE proxy is public and 404s for an un-enabled module (reaches the proxy, not a 401)', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    // The public store surface resolves the default tenant — point it at this tenant.
    await h.db
      .insert(systemState)
      .values({ key: 'default_tenant_id', value: admin.tenantId })
      .onConflictDoUpdate({ target: systemState.key, set: { value: admin.tenantId } });

    await request(h.http()).get('/store/v1/modules/wishlist/ping').expect(404);
  });

  it('ADMIN proxy requires auth → 401 unauthenticated', async () => {
    await request(h.http()).get('/admin/v1/modules/wishlist/ping').expect(401);
  });

  it('ADMIN proxy is fail-closed for staff (no modules:use) → 403', async () => {
    const staff = await seedAdmin(h, { role: 'staff' });
    const token = await login(staff.email, staff.password);
    await request(h.http())
      .get('/admin/v1/modules/wishlist/ping')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('ADMIN proxy: an admin (has modules:use) reaches the proxy → 404 for an un-enabled module', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);
    await request(h.http())
      .get('/admin/v1/modules/wishlist/ping')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('the proxy does NOT shadow the management routes (GET /admin/v1/modules still lists)', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);
    const res = await request(h.http())
      .get('/admin/v1/modules')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
