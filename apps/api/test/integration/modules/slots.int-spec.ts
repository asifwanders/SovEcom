/**
 * Slot registry admin/store API integration.
 *
 * Boots the full AppModule (real Postgres) and drives `/admin/v1/slots` + `/store/v1/slots`.
 * Proves: two enabled modules targeting the SAME slot surface a CONFLICT in the admin view and
 * are OMITTED from the public store map (no silent override); an admin resolution picks a winner
 * that then appears in the store map; staff (no themes:read/write) get 403; and tenant isolation
 * (tenant B's modules are invisible to tenant A's registry).
 *
 * NOTE: ENABLING a module via the real runtime forks `dist/worker-entry.js`, which does not
 * exist under test — so we INSERT `installed_modules` rows directly (enabled=true, a manifest
 * carrying structured `slots`) via the Drizzle handle to exercise the registry without forking.
 */
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  AuthHarness,
  AUTH,
} from '../auth/_auth-harness';
import { installedModules } from '../../../src/database/schema/installed_modules';
import { moduleSlotResolutions } from '../../../src/database/schema/module_slot_resolutions';
import { systemState } from '../../../src/database/schema/system_state';
import { StoreTenantService } from '../../../src/catalog/store-tenant.service';

/** A manifest with structured slot targets. */
function manifest(name: string, slots: { slot: string; component: string }[]) {
  return {
    name,
    displayName: name,
    version: '1.0.0',
    compatibleCore: '^1.0.0',
    permissions: [],
    slots,
  };
}

const ADMIN_BASE = '/admin/v1/slots';

describe('Slot registry admin/store API (integration)', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });
  beforeEach(async () => {
    await resetAuthState(h);
    await h.db.delete(moduleSlotResolutions);
    await h.db.delete(installedModules);
  });

  async function login(email: string, password: string): Promise<string> {
    const res = await request(h.http()).post(AUTH.login).send({ email, password }).expect(200);
    return res.body.accessToken as string;
  }

  /**
   * Point the store's default tenant at `tenantId` AND invalidate the StoreTenantService cache
   * (it memoises the first resolved id in-process — mirrors the customers/payments harnesses).
   */
  async function setStoreTenant(tenantId: string): Promise<void> {
    await h.db
      .insert(systemState)
      .values({ key: 'default_tenant_id', value: tenantId })
      .onConflictDoUpdate({ target: systemState.key, set: { value: tenantId } });
    (
      h.app.get(StoreTenantService, { strict: false }) as unknown as {
        defaultTenantId: string | null;
      }
    ).defaultTenantId = null;
  }

  /** Insert an enabled installed-module row directly (no worker fork). */
  async function seedModule(
    tenantId: string,
    name: string,
    slots: { slot: string; component: string }[],
  ): Promise<void> {
    await h.db.insert(installedModules).values({
      id: uuidv7(),
      tenantId,
      name,
      version: '1.0.0',
      source: 'upload',
      manifest: manifest(name, slots),
      grantedPermissions: [],
      settings: {},
      enabled: true,
    });
  }

  it('two enabled modules on one slot → admin CONFLICT + store OMITS it; resolution fixes it', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);
    // make the store default tenant this admin's tenant
    await setStoreTenant(admin.tenantId);

    await seedModule(admin.tenantId, 'wishlist', [
      { slot: 'product-page', component: 'wishlist-button' },
    ]);
    await seedModule(admin.tenantId, 'reviews', [
      { slot: 'product-page', component: 'reviews-widget' },
    ]);

    // admin sees a conflict, nothing resolved
    const before = await request(h.http())
      .get(ADMIN_BASE)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(before.body.resolved).toEqual([]);
    expect(before.body.conflicts).toHaveLength(1);
    expect(before.body.conflicts[0].slot).toBe('product-page');

    // store omits the contested slot entirely (no silent override)
    const storeBefore = await request(h.http()).get('/store/v1/slots').expect(200);
    expect(storeBefore.body).toEqual({});

    // admin picks the winner
    await request(h.http())
      .put(`${ADMIN_BASE}/product-page/resolution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ module: 'reviews' })
      .expect(204);

    // a row persisted, tenant-scoped
    const rows = await h.db
      .select()
      .from(moduleSlotResolutions)
      .where(eq(moduleSlotResolutions.tenantId, admin.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.moduleName).toBe('reviews');

    // store map now includes the winner
    const storeAfter = await request(h.http()).get('/store/v1/slots').expect(200);
    expect(storeAfter.body).toEqual({
      'product-page': { module: 'reviews', component: 'reviews-widget' },
    });

    // admin view now shows it resolved, no conflict
    const after = await request(h.http())
      .get(ADMIN_BASE)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(after.body.conflicts).toEqual([]);
    expect(after.body.resolved).toEqual([
      { slot: 'product-page', module: 'reviews', component: 'reviews-widget' },
    ]);
  });

  it('a single enabled module on a slot is resolved automatically (store + admin)', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);
    await setStoreTenant(admin.tenantId);
    await seedModule(admin.tenantId, 'wishlist', [{ slot: 'footer', component: 'wishlist-foot' }]);

    const admv = await request(h.http())
      .get(ADMIN_BASE)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(admv.body.resolved).toEqual([
      { slot: 'footer', module: 'wishlist', component: 'wishlist-foot' },
    ]);
    expect(admv.body.conflicts).toEqual([]);

    const store = await request(h.http()).get('/store/v1/slots').expect(200);
    expect(store.body).toEqual({ footer: { module: 'wishlist', component: 'wishlist-foot' } });
  });

  it('PUT resolution rejects a module that does not target the slot (422)', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);
    await seedModule(admin.tenantId, 'wishlist', [
      { slot: 'product-page', component: 'wishlist-button' },
    ]);
    await seedModule(admin.tenantId, 'reviews', [{ slot: 'footer', component: 'reviews-widget' }]);

    await request(h.http())
      .put(`${ADMIN_BASE}/product-page/resolution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ module: 'reviews' }) // reviews does not target product-page
      .expect(422);
    expect(await h.db.select().from(moduleSlotResolutions)).toHaveLength(0);
  });

  it('PUT resolution rejects a module that is not installed/enabled (404)', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);
    await seedModule(admin.tenantId, 'wishlist', [
      { slot: 'product-page', component: 'wishlist-button' },
    ]);

    await request(h.http())
      .put(`${ADMIN_BASE}/product-page/resolution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ module: 'ghost' })
      .expect(404);
  });

  it('staff (no themes:read/write) → 403 on both admin slot endpoints', async () => {
    const staff = await seedAdmin(h, { role: 'staff' });
    const token = await login(staff.email, staff.password);
    await request(h.http()).get(ADMIN_BASE).set('Authorization', `Bearer ${token}`).expect(403);
    await request(h.http())
      .put(`${ADMIN_BASE}/product-page/resolution`)
      .set('Authorization', `Bearer ${token}`)
      .send({ module: 'wishlist' })
      .expect(403);
  });

  it('tenant isolation — tenant B’s enabled modules are invisible to tenant A’s registry', async () => {
    const adminA = await seedAdmin(h, { role: 'admin' });
    const tokenA = await login(adminA.email, adminA.password);
    const adminB = await seedAdmin(h, { role: 'admin' });

    // tenant B has a module on a slot; tenant A has nothing.
    await seedModule(adminB.tenantId, 'wishlist', [
      { slot: 'product-page', component: 'wishlist-button' },
    ]);

    const a = await request(h.http())
      .get(ADMIN_BASE)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(a.body.resolved).toEqual([]);
    expect(a.body.conflicts).toEqual([]);
  });
});
