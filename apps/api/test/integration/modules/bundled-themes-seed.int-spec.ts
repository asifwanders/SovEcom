/**
 * Follow-up A — bundled-theme seed integration (real Postgres).
 *
 * Proves `seedBundledThemes` end-to-end through the SAME admin/store endpoints the switcher (3.9g)
 * and the storefront use:
 *   - run the seed → `GET /admin/v1/themes` lists `default` + `boutique`; `default` is active;
 *   - `POST /admin/v1/themes/boutique/activate` → `GET /store/v1/theme` returns `name:"boutique"`
 *     (so the storefront renders Boutique by active NAME — no STOREFRONT_THEME env);
 *   - re-running the seed is a NO-OP (row count unchanged, active unchanged, count returns 0);
 *   - seeding does NOT deactivate an already-active NON-DEFAULT theme (non-clobber).
 *
 * Mirrors `themes.int-spec.ts` (auth harness + the same endpoints).
 */
import request from 'supertest';
import { eq } from 'drizzle-orm';

import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  AuthHarness,
  AUTH,
} from '../auth/_auth-harness';
import { installedThemes } from '../../../src/database/schema/installed_themes';
import { seedBundledThemes } from '../../../src/database/seeds/themes/seed-themes';
import { StoreTenantService } from '../../../src/catalog/store-tenant.service';

const BASE = '/admin/v1/themes';

describe('Bundled themes seed (follow-up A integration)', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });
  beforeEach(async () => {
    await resetAuthState(h);
    await h.db.delete(installedThemes);
  });

  async function login(email: string, password: string): Promise<string> {
    const res = await request(h.http()).post(AUTH.login).send({ email, password }).expect(200);
    return res.body.accessToken as string;
  }

  /** The public store endpoint resolves the DEFAULT tenant + caches it — clear the cache so a freshly
   *  seeded tenant resolves (mirrors `setDefaultTenant` cache reset in themes.int-spec.ts). seedAdmin
   *  already repointed `default_tenant_id` at this tenant (first makeTenant of the test).
   *  DELIBERATELY resets ONLY StoreTenantService, NOT also AuthService (unlike themes.int-spec.ts):
   *  this suite drives admin endpoints with an already-issued JWT (its `tid` claim carries the tenant,
   *  no default-tenant lookup), so only `/store/v1/theme` reads the cached default tenant. Do NOT
   *  cargo-cult the AuthService reset back in. */
  function clearStoreTenantCache(): void {
    type Cached = { defaultTenantId: string | null };
    (h.app.get(StoreTenantService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  }

  it('seed → admin lists default + boutique, default active; activating boutique flips the store', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);

    const seeded = await seedBundledThemes(h.db, admin.tenantId);
    expect(seeded).toBe(2); // both rows inserted on first run

    // Admin list: both themes, name-ordered (boutique < default lexically).
    const list = await request(h.http())
      .get(BASE)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.map((t: { name: string }) => t.name).sort()).toEqual(['boutique', 'default']);
    const active = list.body.filter((t: { isActive: boolean }) => t.isActive);
    expect(active.map((t: { name: string }) => t.name)).toEqual(['default']);

    // Store currently serves `default` (no STOREFRONT_THEME env in play).
    clearStoreTenantCache();
    const storeDefault = await request(h.http()).get('/store/v1/theme').expect(200);
    expect(storeDefault.body.name).toBe('default');

    // Activate boutique via the admin endpoint → the store now serves `boutique` by NAME, with
    // empty settings (the storefront layers the bundled boutique defaults under these).
    await request(h.http())
      .post(`${BASE}/boutique/activate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    clearStoreTenantCache();
    const storeBoutique = await request(h.http()).get('/store/v1/theme').expect(200);
    expect(storeBoutique.body.name).toBe('boutique');
    expect(storeBoutique.body.settings).toEqual({}); // name-only row → empty settings bag
  });

  it('re-running the seed is a NO-OP: counts unchanged, active unchanged, returns 0', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });

    const first = await seedBundledThemes(h.db, admin.tenantId);
    expect(first).toBe(2);

    const before = await h.db
      .select()
      .from(installedThemes)
      .where(eq(installedThemes.tenantId, admin.tenantId));
    expect(before).toHaveLength(2);
    expect(before.filter((t) => t.isActive).map((t) => t.name)).toEqual(['default']);

    // Second run inserts nothing and does not error.
    const second = await seedBundledThemes(h.db, admin.tenantId);
    expect(second).toBe(0);

    const after = await h.db
      .select()
      .from(installedThemes)
      .where(eq(installedThemes.tenantId, admin.tenantId));
    expect(after).toHaveLength(2);
    expect(after.filter((t) => t.isActive).map((t) => t.name)).toEqual(['default']);
  });

  it('NON-CLOBBER: seeding does NOT deactivate an already-active non-default theme', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });

    // An admin has already installed + activated a custom theme (e.g. an uploaded `aurora`).
    await h.db.insert(installedThemes).values({
      tenantId: admin.tenantId,
      name: 'aurora',
      version: '2.0.0',
      source: 'upload',
      manifest: {
        name: 'aurora',
        displayName: 'Aurora',
        version: '2.0.0',
        compatibleCore: '^1.0.0',
      },
      settings: { primaryColor: '#123456' },
      templates: {},
      isActive: true,
    });

    // Now the seed runs (e.g. a later boot). It inserts the two bundled rows but MUST NOT touch the
    // admin's active `aurora` — the guarded activate only fires when NO theme is active.
    const seeded = await seedBundledThemes(h.db, admin.tenantId);
    expect(seeded).toBe(2);

    const rows = await h.db
      .select()
      .from(installedThemes)
      .where(eq(installedThemes.tenantId, admin.tenantId));
    expect(rows.map((t) => t.name).sort()).toEqual(['aurora', 'boutique', 'default']);
    // aurora is STILL the single active theme — default was NOT activated, the admin choice stands.
    expect(rows.filter((t) => t.isActive).map((t) => t.name)).toEqual(['aurora']);
    // And the admin's edited aurora settings are untouched (never clobbered).
    const aurora = rows.find((t) => t.name === 'aurora')!;
    expect(aurora.settings).toEqual({ primaryColor: '#123456' });
  });

  it('NON-CLOBBER: an existing edited `default` row is not overwritten by the seed', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });

    // Pre-existing `default` row the admin has edited (custom settings, marked active).
    await h.db.insert(installedThemes).values({
      tenantId: admin.tenantId,
      name: 'default',
      version: '1.0.0',
      source: 'bundled',
      manifest: {
        name: 'default',
        displayName: 'Default',
        version: '1.0.0',
        compatibleCore: '^1.0.0',
      },
      settings: { logoUrl: 'https://example.test/logo.svg' },
      templates: {},
      isActive: true,
    });

    const seeded = await seedBundledThemes(h.db, admin.tenantId);
    expect(seeded).toBe(1); // only `boutique` is new; `default` conflict is skipped

    const def = (
      await h.db.select().from(installedThemes).where(eq(installedThemes.tenantId, admin.tenantId))
    ).find((t) => t.name === 'default')!;
    // The admin's edited settings survive (ON CONFLICT DO NOTHING, never overwrite).
    expect(def.settings).toEqual({ logoUrl: 'https://example.test/logo.svg' });
  });
});
