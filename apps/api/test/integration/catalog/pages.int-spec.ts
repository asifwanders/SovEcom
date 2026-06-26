/**
 * CMS-lite Pages API integration tests.
 *
 * Real Postgres + Redis via the auth harness. Covers:
 *   - Store GET published → 200 + allowlist shape (no id/tenant_id/status/timestamps)
 *   - Store draft / unknown / wrong-locale → 404 (no default-locale fallback)
 * - Store locale default = 'en'; invalid ?locale= → 400
 *   - Store tenant scoping (tenant-A page invisible to tenant-B default-tenant read)
 *   - Store rate-limit 429
 *   - Admin CRUD happy paths + filters
 *   - RBAC: unauth → 401; staff write OK; staff delete → 403; missing perm
 *   - Validation: bad locale/status, empty title → 400
 *   - Duplicate (tenant, slug, locale) → 409
 *   - Audit row written on create/update/delete
 *   - Admin tenant isolation
 */
import request from 'supertest';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  auditRows,
  AuthHarness,
  AUTH,
  newId,
} from '../auth/_auth-harness';
import { AuthService } from '../../../src/auth/services/auth.service';
import { ResetService } from '../../../src/auth/services/reset.service';
import { StoreTenantService } from '../../../src/catalog/store-tenant.service';

const ADMIN_PAGES = '/admin/v1/pages';
const STORE_PAGES = '/store/v1/pages';

async function login(h: AuthHarness, email: string, password: string): Promise<string> {
  const res = await request(h.http()).post(AUTH.login).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

async function insertTenant(h: AuthHarness): Promise<string> {
  const id = newId();
  const slug = `tenant-${id.slice(-8)}`;
  await h.client`insert into tenants (id, name, slug) values (${id}, ${slug}, ${slug})`;
  return id;
}

async function switchDefaultTenant(h: AuthHarness, id: string): Promise<void> {
  await h.client`
    insert into system_state (key, value)
    values ('default_tenant_id', to_jsonb(${id}::text))
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
  type Cached = { defaultTenantId: string | null };
  (h.app.get(AuthService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  (h.app.get(ResetService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  (h.app.get(StoreTenantService, { strict: false }) as unknown as Cached).defaultTenantId = null;
}

function pagePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: `slug-${newId().slice(-8)}`,
    title: 'Terms of Service',
    body: '# Terms\n\nSome **markdown** body.',
    locale: 'en',
    status: 'published',
    ...over,
  };
}

async function createPage(
  h: AuthHarness,
  token: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; slug: string; locale: string; status: string }> {
  const res = await request(h.http())
    .post(ADMIN_PAGES)
    .set('Authorization', `Bearer ${token}`)
    .send(pagePayload(over))
    .expect(201);
  return res.body;
}

describe('Catalog API — CMS-lite pages integration', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });
  beforeEach(async () => {
    await resetAuthState(h);
    type Cached = { defaultTenantId: string | null };
    (h.app.get(StoreTenantService, { strict: false }) as unknown as Cached).defaultTenantId = null;
  });

  // ── Admin CRUD ──────────────────────────────────────────────────────────────

  describe('POST /admin/v1/pages', () => {
    it('creates a page and returns the full admin row', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const res = await request(h.http())
        .post(ADMIN_PAGES)
        .set('Authorization', `Bearer ${token}`)
        .send(pagePayload({ slug: 'about', locale: 'en', status: 'draft' }))
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.slug).toBe('about');
      expect(res.body.locale).toBe('en');
      expect(res.body.status).toBe('draft');
      // Admin row intentionally exposes tenantId + timestamps.
      expect(res.body.tenantId).toBe(admin.tenantId);
      expect(res.body.createdAt).toBeDefined();
    });

    it('defaults status to draft when omitted', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const res = await request(h.http())
        .post(ADMIN_PAGES)
        .set('Authorization', `Bearer ${token}`)
        .send({ slug: `nostat-${newId().slice(-6)}`, title: 'T', body: 'B', locale: 'fr' })
        .expect(201);
      expect(res.body.status).toBe('draft');
    });

    it('writes an audit row on create', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      const page = await createPage(h, token, { slug: 'audited' });
      const rows = await auditRows(h, 'page.created');
      const mine = rows.find((r) => r.resource_id === page.id);
      expect(mine).toBeDefined();
      expect(mine!.actor_id).toBe(admin.id);
      expect(mine!.resource_type).toBe('page');
    });

    it('returns 401 unauthenticated', async () => {
      await request(h.http()).post(ADMIN_PAGES).send(pagePayload()).expect(401);
    });

    it('allows two pages with the same slug in DIFFERENT locales', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await createPage(h, token, { slug: 'privacy', locale: 'en' });
      await createPage(h, token, { slug: 'privacy', locale: 'fr' });
    });

    it('rejects a duplicate (tenant, slug, locale) with 409', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await createPage(h, token, { slug: 'dup', locale: 'en' });
      await request(h.http())
        .post(ADMIN_PAGES)
        .set('Authorization', `Bearer ${token}`)
        .send(pagePayload({ slug: 'dup', locale: 'en' }))
        .expect(409);
    });
  });

  // ── Validation ────────────────────────────────────────────────────────────

  describe('Validation (400)', () => {
    it('rejects an invalid locale', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await request(h.http())
        .post(ADMIN_PAGES)
        .set('Authorization', `Bearer ${token}`)
        .send(pagePayload({ locale: 'de' }))
        .expect(400);
    });

    it('rejects an invalid status', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await request(h.http())
        .post(ADMIN_PAGES)
        .set('Authorization', `Bearer ${token}`)
        .send(pagePayload({ status: 'live' }))
        .expect(400);
    });

    it('rejects an empty title', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await request(h.http())
        .post(ADMIN_PAGES)
        .set('Authorization', `Bearer ${token}`)
        .send(pagePayload({ title: '' }))
        .expect(400);
    });

    it('rejects an unknown field (strict)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await request(h.http())
        .post(ADMIN_PAGES)
        .set('Authorization', `Bearer ${token}`)
        .send(pagePayload({ published: true }))
        .expect(400);
    });
  });

  // ── Admin read / list / update / delete ─────────────────────────────────────

  describe('GET / PATCH / DELETE /admin/v1/pages', () => {
    it('lists pages with locale + status filters', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);

      await createPage(h, token, { slug: 'a', locale: 'en', status: 'published' });
      await createPage(h, token, { slug: 'b', locale: 'fr', status: 'draft' });

      const all = await request(h.http())
        .get(ADMIN_PAGES)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((all.body as unknown[]).length).toBe(2);

      const enOnly = await request(h.http())
        .get(`${ADMIN_PAGES}?locale=en`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((enOnly.body as Array<{ locale: string }>).every((p) => p.locale === 'en')).toBe(true);
      expect((enOnly.body as unknown[]).length).toBe(1);

      const draftOnly = await request(h.http())
        .get(`${ADMIN_PAGES}?status=draft`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect((draftOnly.body as Array<{ status: string }>).every((p) => p.status === 'draft')).toBe(
        true,
      );
    });

    it('GET /:id returns the page; unknown id → 404', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const page = await createPage(h, token);

      const res = await request(h.http())
        .get(`${ADMIN_PAGES}/${page.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.id).toBe(page.id);

      await request(h.http())
        .get(`${ADMIN_PAGES}/${newId()}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('PATCH updates fields + writes an audit row', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const page = await createPage(h, token, { status: 'draft' });

      const res = await request(h.http())
        .patch(`${ADMIN_PAGES}/${page.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ title: 'Renamed', status: 'published' })
        .expect(200);
      expect(res.body.title).toBe('Renamed');
      expect(res.body.status).toBe('published');

      const rows = await auditRows(h, 'page.updated');
      expect(rows.find((r) => r.resource_id === page.id)).toBeDefined();
    });

    it('PATCH into a conflicting (slug, locale) → 409', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await createPage(h, token, { slug: 'taken', locale: 'en' });
      const movable = await createPage(h, token, { slug: 'movable', locale: 'en' });

      await request(h.http())
        .patch(`${ADMIN_PAGES}/${movable.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ slug: 'taken' })
        .expect(409);
    });

    it('DELETE removes the page (204) + audit row; second delete → 404', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      const page = await createPage(h, token);

      await request(h.http())
        .delete(`${ADMIN_PAGES}/${page.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      const rows = await auditRows(h, 'page.deleted');
      expect(rows.find((r) => r.resource_id === page.id)).toBeDefined();

      await request(h.http())
        .delete(`${ADMIN_PAGES}/${page.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  // ── RBAC ────────────────────────────────────────────────────────────────────

  describe('RBAC', () => {
    it('staff (PAGES_WRITE) can create', async () => {
      const staff = await seedAdmin(h, { role: 'staff' });
      const token = await login(h, staff.email, staff.password);
      await request(h.http())
        .post(ADMIN_PAGES)
        .set('Authorization', `Bearer ${token}`)
        .send(pagePayload())
        .expect(201);
    });

    it('staff lacks PAGES_DELETE → 403', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const adminToken = await login(h, admin.email, admin.password);
      const page = await createPage(h, adminToken);

      const staff = await seedAdmin(h, { tenantId: admin.tenantId, role: 'staff' });
      const staffToken = await login(h, staff.email, staff.password);

      await request(h.http())
        .delete(`${ADMIN_PAGES}/${page.id}`)
        .set('Authorization', `Bearer ${staffToken}`)
        .expect(403);
    });
  });

  // ── Store read ──────────────────────────────────────────────────────────────

  describe('GET /store/v1/pages/:slug', () => {
    it('returns a published page (200) with the allowlist shape only', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      await createPage(h, token, { slug: 'terms', locale: 'en', status: 'published' });

      const res = await request(h.http()).get(`${STORE_PAGES}/terms?locale=en`).expect(200);

      expect(res.body).toEqual({
        slug: 'terms',
        title: 'Terms of Service',
        body: '# Terms\n\nSome **markdown** body.',
        locale: 'en',
        seoTitle: null,
        seoDescription: null,
      });
      // Allowlist: no leaked fields.
      for (const field of ['id', 'tenantId', 'tenant_id', 'status', 'createdAt', 'updatedAt']) {
        expect(res.body).not.toHaveProperty(field);
      }
    });

    it('is public (no auth required)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);
      await createPage(h, token, { slug: 'pub', locale: 'en', status: 'published' });

      await request(h.http()).get(`${STORE_PAGES}/pub?locale=en`).expect(200);
    });

    it('defaults to locale en when ?locale= is absent', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      // Same slug in both locales — the default (no query) must resolve EN.
      await createPage(h, token, { slug: 'home', locale: 'en', title: 'EN Home' });
      await createPage(h, token, { slug: 'home', locale: 'fr', title: 'FR Home' });

      const res = await request(h.http()).get(`${STORE_PAGES}/home`).expect(200);
      expect(res.body.locale).toBe('en');
      expect(res.body.title).toBe('EN Home');
    });

    it('serves the FR row when ?locale=fr', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);
      await createPage(h, token, { slug: 'home', locale: 'fr', title: 'FR Home' });

      const res = await request(h.http()).get(`${STORE_PAGES}/home?locale=fr`).expect(200);
      expect(res.body.locale).toBe('fr');
    });

    it('returns 404 for a draft page (published-only)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);
      await createPage(h, token, { slug: 'secret', locale: 'en', status: 'draft' });

      await request(h.http()).get(`${STORE_PAGES}/secret?locale=en`).expect(404);
    });

    it('returns 404 for an unknown slug', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);
      await request(h.http()).get(`${STORE_PAGES}/does-not-exist?locale=en`).expect(404);
    });

    it('returns 404 for a wrong-locale request (no default-locale fallback)', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);
      // Only an EN row exists; asking for FR must 404, not fall back to EN.
      await createPage(h, token, { slug: 'enonly', locale: 'en', status: 'published' });

      await request(h.http()).get(`${STORE_PAGES}/enonly?locale=fr`).expect(404);
    });

    it('returns 400 for an invalid ?locale=', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      const token = await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);
      await createPage(h, token, { slug: 'badloc', locale: 'en', status: 'published' });

      await request(h.http()).get(`${STORE_PAGES}/badloc?locale=de`).expect(400);
    });

    it('does not leak pages from the wrong tenant', async () => {
      // Tenant A publishes a page; the store points at tenant B (no pages).
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);
      await createPage(h, tokenA, { slug: 'isolated', locale: 'en', status: 'published' });

      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);

      await request(h.http()).get(`${STORE_PAGES}/isolated?locale=en`).expect(404);
    });

    it('store rate-limit triggers 429', async () => {
      const admin = await seedAdmin(h, { role: 'admin' });
      await login(h, admin.email, admin.password);
      await switchDefaultTenant(h, admin.tenantId);

      let saw429 = false;
      for (let i = 0; i < 130; i++) {
        const res = await request(h.http()).get(`${STORE_PAGES}/whatever?locale=en`);
        if (res.status === 429) {
          saw429 = true;
          break;
        }
      }
      expect(saw429).toBe(true);
    });
  });

  // ── Admin tenant isolation ──────────────────────────────────────────────────

  describe('Tenant isolation (admin)', () => {
    it('admin B cannot GET / PATCH / DELETE a page from tenant A', async () => {
      const adminA = await seedAdmin(h, { role: 'admin' });
      const tokenA = await login(h, adminA.email, adminA.password);
      const pageA = await createPage(h, tokenA, { slug: `iso-${newId().slice(-6)}` });

      const tenantB = await insertTenant(h);
      await switchDefaultTenant(h, tenantB);
      const adminB = await seedAdmin(h, { tenantId: tenantB, role: 'admin' });
      const tokenB = await login(h, adminB.email, adminB.password);

      await request(h.http())
        .get(`${ADMIN_PAGES}/${pageA.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
      await request(h.http())
        .patch(`${ADMIN_PAGES}/${pageA.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ title: 'Hijack' })
        .expect(404);
      await request(h.http())
        .delete(`${ADMIN_PAGES}/${pageA.id}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404);
    });
  });
});
