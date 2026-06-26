/**
 * Themes admin/store API integration.
 *
 * Boots the full AppModule (real Postgres) and drives `/admin/v1/themes` + `/store/v1/theme` with
 * REAL `.tgz` uploads. Proves: install persists a tenant-scoped row; activation holds the
 * single-active invariant; settings persist + surface on the public store endpoint; RBAC
 * (themes:write) is fail-closed for staff; and the SHARED hardened extractor rejects a zip-slip
 * theme tarball (the same guards as modules).
 */
import request from 'supertest';
import * as zlib from 'zlib';
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
import { systemState } from '../../../src/database/schema/system_state';
import { StoreTenantService } from '../../../src/catalog/store-tenant.service';
import { AuthService } from '../../../src/auth/services/auth.service';

// ── minimal USTAR tar writer (mirrors modules.int-spec.ts) ──────────────────────
const BLOCK = 512;
interface TarEntry {
  name: string;
  type?: '0' | '5';
  data?: Buffer;
}
function octal(value: number, len: number): string {
  return value.toString(8).padStart(len - 1, '0') + '\0';
}
function tarHeader(entry: TarEntry): Buffer {
  const buf = Buffer.alloc(BLOCK, 0);
  buf.write(entry.name.slice(0, 100), 0, 'utf8');
  buf.write('0000644\0', 100, 'ascii');
  buf.write('0000000\0', 108, 'ascii');
  buf.write('0000000\0', 116, 'ascii');
  buf.write(octal(entry.data?.length ?? 0, 12), 124, 'ascii');
  buf.write(octal(0, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii');
  buf.write(entry.type ?? '0', 156, 'ascii');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i] ?? 0;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return buf;
}
function buildTgz(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(tarHeader(e));
    if (e.type === '5') continue;
    const data = e.data ?? Buffer.alloc(0);
    parts.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}
function themeManifest(over: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      name: 'aurora',
      displayName: 'Aurora',
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      slots: ['product-page'],
      ...over,
    }),
  );
}
function validThemeTgz(over: Record<string, unknown> = {}): Buffer {
  return buildTgz([
    { name: 'package/', type: '5' },
    { name: 'package/sovecom.theme.json', data: themeManifest(over) },
    { name: 'package/assets/logo.svg', data: Buffer.from('<svg/>') },
  ]);
}

/**
 * A theme tarball that DECLARES + ships wire templates. `templates` is the manifest declaration;
 * `files` are the JSON files it points at, written into the tarball.
 */
function themeTgzWithTemplates(
  name: string,
  declarations: { page: string; path: string }[],
  files: { path: string; data: Buffer }[],
): Buffer {
  return buildTgz([
    { name: 'package/', type: '5' },
    {
      name: 'package/sovecom.theme.json',
      data: themeManifest({ name, templates: declarations }),
    },
    ...files.map((f) => ({ name: `package/${f.path}`, data: f.data })),
  ]);
}

const BASE = '/admin/v1/themes';

describe('Themes admin/store API (integration)', () => {
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

  it('admin installs a theme → a tenant-scoped row; GET lists it', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);
    const res = await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', validThemeTgz(), { filename: 'aurora.tgz', contentType: 'application/gzip' })
      .expect(201);
    expect(res.body.name).toBe('aurora');

    const rows = await h.db
      .select()
      .from(installedThemes)
      .where(eq(installedThemes.tenantId, admin.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isActive).toBe(false); // install does not auto-activate

    const list = await request(h.http())
      .get(BASE)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body.map((t: { name: string }) => t.name)).toEqual(['aurora']);
  });

  it('activation holds the single-active invariant (activating B deactivates A)', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);
    const install = (name: string) =>
      request(h.http())
        .post(`${BASE}/install`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', validThemeTgz({ name }), { filename: `${name}.tgz` })
        .expect(201);
    await install('aurora');
    await install('nimbus');

    await request(h.http())
      .post(`${BASE}/aurora/activate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(h.http())
      .post(`${BASE}/nimbus/activate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const active = await h.db
      .select()
      .from(installedThemes)
      .where(eq(installedThemes.tenantId, admin.tenantId));
    expect(active.filter((t) => t.isActive).map((t) => t.name)).toEqual(['nimbus']); // exactly one
  });

  it('settings persist and surface on the PUBLIC store endpoint', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);
    await h.db
      .insert(systemState)
      .values({ key: 'default_tenant_id', value: admin.tenantId })
      .onConflictDoUpdate({ target: systemState.key, set: { value: admin.tenantId } });

    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', validThemeTgz(), { filename: 'aurora.tgz' })
      .expect(201);
    await request(h.http())
      .post(`${BASE}/aurora/activate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    await request(h.http())
      .patch(`${BASE}/aurora/settings`)
      .set('Authorization', `Bearer ${token}`)
      .send({ settings: { primaryColor: '#00B9A0' } })
      .expect(200);

    // public — no auth header
    const store = await request(h.http()).get('/store/v1/theme').expect(200);
    expect(store.body.name).toBe('aurora');
    expect(store.body.settings).toMatchObject({ primaryColor: '#00B9A0' });
  });

  it('activating a NON-existent theme 404s and leaves the live active theme untouched', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);

    // Install + activate A.
    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', validThemeTgz({ name: 'aurora' }), { filename: 'aurora.tgz' })
      .expect(201);
    await request(h.http())
      .post(`${BASE}/aurora/activate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // Activating a theme that is NOT installed → 404, and MUST NOT deactivate A.
    // The old code deactivated all-other-themes FIRST, so a missing target silently unset the
    // live active theme and committed, leaving the storefront with no active theme while 404ing.
    await request(h.http())
      .post(`${BASE}/ghost/activate`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    // A is STILL the single active theme for this tenant — i.e. the storefront still has a theme
    // to serve.
    const rows = await h.db
      .select()
      .from(installedThemes)
      .where(eq(installedThemes.tenantId, admin.tenantId));
    expect(rows.filter((t) => t.isActive).map((t) => t.name)).toEqual(['aurora']);
  });

  it('staff (no themes:write) → 403 on install', async () => {
    const staff = await seedAdmin(h, { role: 'staff' });
    const token = await login(staff.email, staff.password);
    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', validThemeTgz(), { filename: 'aurora.tgz' })
      .expect(403);
    expect(await h.db.select().from(installedThemes)).toHaveLength(0);
  });

  it('the SHARED hardened extractor rejects a zip-slip theme tarball', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(admin.email, admin.password);
    const evil = buildTgz([
      { name: 'package/', type: '5' },
      { name: 'package/sovecom.theme.json', data: themeManifest() },
      { name: 'package/../../evil.txt', data: Buffer.from('pwned') },
    ]);
    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', evil, { filename: 'evil.tgz' })
      .expect(422);
    expect(await h.db.select().from(installedThemes)).toHaveLength(0);
  });

  describe('wire-delivered theme templates', () => {
    const homeJson = Buffer.from(
      JSON.stringify({ page: 'home', sections: [{ type: 'hero' }, { type: 'featured-products' }] }),
    );
    const productJson = Buffer.from(JSON.stringify({ page: 'product', sections: [] }));

    async function setDefaultTenant(tenantId: string): Promise<void> {
      await h.db
        .insert(systemState)
        .values({ key: 'default_tenant_id', value: tenantId })
        .onConflictDoUpdate({ target: systemState.key, set: { value: tenantId } });
      // Both AuthService (login resolves the default tenant) and StoreTenantService (the public
      // endpoint resolves it) cache the default tenant id for the lifetime of the booted app with no
      // invalidation hook. Each test seeds fresh tenants, so reset BOTH caches (mirrors how the auth
      // harness resets AuthService/ResetService) or login / the store endpoint resolve a stale tenant.
      type Cached = { defaultTenantId: string | null };
      (h.app.get(StoreTenantService, { strict: false }) as unknown as Cached).defaultTenantId =
        null;
      (h.app.get(AuthService, { strict: false }) as unknown as Cached).defaultTenantId = null;
    }

    it('install persists the validated templates on the tenant-scoped row', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(admin.email, admin.password);
      const tgz = themeTgzWithTemplates(
        'aurora',
        [
          { page: 'home', path: 'templates/home.json' },
          { page: 'product', path: 'product.json' },
        ],
        [
          { path: 'templates/home.json', data: homeJson },
          { path: 'product.json', data: productJson },
        ],
      );
      await request(h.http())
        .post(`${BASE}/install`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', tgz, { filename: 'aurora.tgz' })
        .expect(201);

      const rows = await h.db
        .select()
        .from(installedThemes)
        .where(eq(installedThemes.tenantId, admin.tenantId));
      expect(rows).toHaveLength(1);
      const templates = rows[0]!.templates as Record<string, unknown>;
      expect(Object.keys(templates).sort()).toEqual(['home', 'product']);
      expect(templates.home).toEqual({
        page: 'home',
        sections: [{ type: 'hero' }, { type: 'featured-products' }],
      });
    });

    it('activate → GET /store/v1/theme returns the validated templates (public)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(admin.email, admin.password);
      await setDefaultTenant(admin.tenantId);

      const tgz = themeTgzWithTemplates(
        'aurora',
        [{ page: 'home', path: 'templates/home.json' }],
        [{ path: 'templates/home.json', data: homeJson }],
      );
      await request(h.http())
        .post(`${BASE}/install`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', tgz, { filename: 'aurora.tgz' })
        .expect(201);
      await request(h.http())
        .post(`${BASE}/aurora/activate`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const store = await request(h.http()).get('/store/v1/theme').expect(200);
      expect(store.body.name).toBe('aurora');
      expect(store.body.templates).toBeDefined();
      expect(store.body.templates.home).toEqual({
        page: 'home',
        sections: [{ type: 'hero' }, { type: 'featured-products' }],
      });
      // NEVER leaks the manifest or on-disk path.
      expect(store.body).not.toHaveProperty('manifest');
      expect(JSON.stringify(store.body)).not.toContain('/data/themes');
    });

    it('a theme shipping NO templates → store endpoint omits templates (tokens-only)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(admin.email, admin.password);
      await setDefaultTenant(admin.tenantId);

      await request(h.http())
        .post(`${BASE}/install`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', validThemeTgz({ name: 'plain' }), { filename: 'plain.tgz' })
        .expect(201);
      await request(h.http())
        .post(`${BASE}/plain/activate`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const store = await request(h.http()).get('/store/v1/theme').expect(200);
      expect(store.body.name).toBe('plain');
      expect(store.body.templates).toBeUndefined(); // additive: absent when none shipped
    });

    it('REJECTS an install whose template page does not match the declaration (page spoof)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(admin.email, admin.password);
      const tgz = themeTgzWithTemplates(
        'aurora',
        [{ page: 'home', path: 'home.json' }],
        // file claims page:"product" but the manifest declares it for "home"
        [{ path: 'home.json', data: productJson }],
      );
      await request(h.http())
        .post(`${BASE}/install`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', tgz, { filename: 'aurora.tgz' })
        .expect(422);
      // The install was rejected at the trust boundary — no row persisted.
      expect(await h.db.select().from(installedThemes)).toHaveLength(0);
    });

    it('tenant-scoping: the store serves ONLY the requesting tenant`s templates — tenant B never leaks', async () => {
      // TWO real tenants, EACH with a distinct active theme that ships its OWN templates. The public
      // `GET /store/v1/theme` resolves the DEFAULT tenant, so flipping the default tenant flips which
      // tenant`s templates are served — and the OTHER tenant`s templates must NEVER surface. This is
      // a genuine NEGATIVE assertion: it FAILS if `findActive` ever dropped its tenant filter.
      // Tenant A is the first-seeded → the login default tenant. Log in + provision A while A is default.
      const adminA = await seedAdmin(h, { role: 'admin' });
      await setDefaultTenant(adminA.tenantId);
      const tokenA = await login(adminA.email, adminA.password);

      // Tenant A: install + activate a theme that ships a `home` template (sections: hero+featured).
      const tgzA = themeTgzWithTemplates(
        'aurora',
        [{ page: 'home', path: 'home.json' }],
        [{ path: 'home.json', data: homeJson }],
      );
      await request(h.http())
        .post(`${BASE}/install`)
        .set('Authorization', `Bearer ${tokenA}`)
        .attach('file', tgzA, { filename: 'aurora.tgz' })
        .expect(201);
      await request(h.http())
        .post(`${BASE}/aurora/activate`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      // A SECOND, distinct tenant B. Login is resolved against the default tenant, so flip the
      // default to B before logging B in + provisioning it.
      const adminB = await seedAdmin(h, { role: 'admin' });
      expect(adminB.tenantId).not.toBe(adminA.tenantId);
      await setDefaultTenant(adminB.tenantId);
      const tokenB = await login(adminB.email, adminB.password);

      // Tenant B: a DIFFERENT theme shipping a DISTINCT `home` template (a single `cart-summary`
      // section) — so a leak would be unmistakable in the served body.
      const bHome = Buffer.from(
        JSON.stringify({ page: 'home', sections: [{ type: 'cart-summary' }] }),
      );
      const tgzB = themeTgzWithTemplates(
        'borealis',
        [{ page: 'home', path: 'home.json' }],
        [{ path: 'home.json', data: bHome }],
      );
      await request(h.http())
        .post(`${BASE}/install`)
        .set('Authorization', `Bearer ${tokenB}`)
        .attach('file', tgzB, { filename: 'borealis.tgz' })
        .expect(201);
      await request(h.http())
        .post(`${BASE}/borealis/activate`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      // Default tenant = A → the store serves ONLY A`s templates; B`s `borealis`/`cart-summary`
      // template must NOT appear anywhere in the response.
      await setDefaultTenant(adminA.tenantId);
      const storeA = await request(h.http()).get('/store/v1/theme').expect(200);
      expect(storeA.body.name).toBe('aurora');
      expect(storeA.body.templates.home).toEqual({
        page: 'home',
        sections: [{ type: 'hero' }, { type: 'featured-products' }],
      });
      expect(JSON.stringify(storeA.body)).not.toContain('borealis');
      expect(JSON.stringify(storeA.body)).not.toContain('cart-summary');

      // Reverse: flip the default tenant to B → the store now serves ONLY B`s templates; A`s
      // `aurora`/`featured-products` template must NOT appear. (No code path reads the other row.)
      await setDefaultTenant(adminB.tenantId);
      const storeB = await request(h.http()).get('/store/v1/theme').expect(200);
      expect(storeB.body.name).toBe('borealis');
      expect(storeB.body.templates.home).toEqual({
        page: 'home',
        sections: [{ type: 'cart-summary' }],
      });
      expect(JSON.stringify(storeB.body)).not.toContain('aurora');
      expect(JSON.stringify(storeB.body)).not.toContain('featured-products');
    });
  });
});
