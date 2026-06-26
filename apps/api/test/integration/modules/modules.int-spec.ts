/**
 * Modules admin API integration tests (SECURITY-CRITICAL).
 *
 * Boots the full `AppModule` (real Postgres + the global Jwt/Permissions guards) and drives
 * the `/admin/v1/modules` surface end-to-end with REAL `.tgz` uploads. We hand-roll a tiny
 * USTAR writer so we can craft both valid and malicious tarballs in-process.
 *
 * The security invariants under test:
 *   - a valid module installs → a tenant-scoped row is persisted with the INTERSECTED grant;
 *   - an upload requesting a permission NOT declared in the manifest never stores that perm;
 *   - staff (no modules:* perms) → 403 on inspect/install;
 *   - tenant isolation: tenant-2 cannot SEE or UNINSTALL tenant-1's module;
 *   - install does NOT execute module code (a postinstall-marker tarball → marker never made);
 *   - an incompatible-core manifest → 422; a malformed tarball → a clean 4xx;
 *   - a double-install → 409 (no silent overwrite / no update).
 */
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { eq, and } from 'drizzle-orm';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  AuthHarness,
  AUTH,
} from '../auth/_auth-harness';
import { installedModules } from '../../../src/database/schema/installed_modules';
import { ModuleIngestService } from '../../../src/modules/module-ingest.service';

const BASE = '/admin/v1/modules';

// ── minimal USTAR tar writer (mirrors module-ingest.spec.ts) ────────────────────

const BLOCK = 512;
interface TarEntry {
  name: string;
  type?: '0' | '5' | '2' | '1';
  data?: Buffer;
  linkname?: string;
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
  const size = entry.data?.length ?? 0;
  buf.write(octal(size, 12), 124, 'ascii');
  buf.write(octal(0, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii');
  buf.write(entry.type ?? '0', 156, 'ascii');
  if (entry.linkname) buf.write(entry.linkname.slice(0, 100), 157, 'utf8');
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i] ?? 0;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return buf;
}
function buildTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(tarHeader(e));
    if (e.type === '5' || e.type === '2' || e.type === '1') continue;
    const data = e.data ?? Buffer.alloc(0);
    parts.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}
const gzip = (b: Buffer): Buffer => zlib.gzipSync(b);

function manifestJson(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      name: 'wishlist',
      displayName: 'Wishlist',
      version: '1.2.3',
      compatibleCore: '^1.0.0',
      permissions: ['read:products', 'read:categories'],
      slots: [{ slot: 'product-page', component: 'wishlist-button' }],
      tables: ['mod_wishlist_items'],
      ...overrides,
    }),
  );
}

/** A standard npm-style tarball (everything under `package/`). */
function validTgz(manifestOverrides: Record<string, unknown> = {}, extra: TarEntry[] = []): Buffer {
  return gzip(
    buildTar([
      { name: 'package/', type: '5' },
      { name: 'package/sovecom.module.json', data: manifestJson(manifestOverrides) },
      { name: 'package/index.js', data: Buffer.from('module.exports = {};\n') },
      ...extra,
    ]),
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────────

async function login(h: AuthHarness, email: string, password: string): Promise<string> {
  const res = await request(h.http()).post(AUTH.login).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** The modules root the running AppModule extracts into (set in test/setup-env.ts). */
function modulesRoot(): string {
  return path.resolve(
    process.env['MODULES_DATA_PATH'] ?? path.join(os.tmpdir(), 'sovecom-test-modules'),
  );
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('Modules admin API (integration)', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => {
    await teardownAuthApp(h);
    // Clean up any per-module dirs this suite created.
    await fs.promises.rm(modulesRoot(), { recursive: true, force: true }).catch(() => undefined);
  });
  beforeEach(async () => {
    await resetAuthState(h);
    // Remove the `wishlist` module dir between tests so a re-install starts clean.
    await new ModuleIngestService(modulesRoot()).removeModuleDir('wishlist');
  });

  // ── install (happy path + persistence) ────────────────────────────────────────

  it('admin installs a valid module → a tenant-scoped row with the INTERSECTED grant', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);

    const res = await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', JSON.stringify(['read:products'])) // only ONE of two declared
      .attach('file', validTgz(), { filename: 'wishlist.tgz', contentType: 'application/gzip' })
      .expect(201);

    expect(res.body.name).toBe('wishlist');
    expect(res.body.version).toBe('1.2.3');
    expect(res.body.grantedPermissions).toEqual(['read:products']); // read:categories NOT granted
    expect(res.body.slots).toEqual([{ slot: 'product-page', component: 'wishlist-button' }]);
    expect(res.body.enabled).toBe(true);

    // Persisted, tenant-scoped, with the intersected grant.
    const rows = await h.db
      .select()
      .from(installedModules)
      .where(eq(installedModules.tenantId, admin.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.grantedPermissions).toEqual(['read:products']);
    expect(rows[0]!.source).toBe('upload');
    expect(rows[0]!.enabled).toBe(true);
  });

  it('an upload requesting an UNDECLARED permission never stores it (default-deny)', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);

    const res = await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      // request a declared perm AND read:orders (NOT in the manifest) + read:customers (PII, not declared)
      .field(
        'grantedPermissions',
        JSON.stringify(['read:products', 'read:orders', 'read:customers']),
      )
      .attach('file', validTgz(), { filename: 'wishlist.tgz' })
      .expect(201);

    expect(res.body.grantedPermissions).toEqual(['read:products']);
    const rows = await h.db
      .select()
      .from(installedModules)
      .where(eq(installedModules.tenantId, admin.tenantId));
    expect(rows[0]!.grantedPermissions).toEqual(['read:products']);
    expect(rows[0]!.grantedPermissions).not.toContain('read:orders');
    expect(rows[0]!.grantedPermissions).not.toContain('read:customers');
  });

  // ── inspect (no persist) ──────────────────────────────────────────────────────

  it('inspect verifies + echoes the requested surface WITHOUT persisting', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);

    const res = await request(h.http())
      .post(`${BASE}/inspect`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', validTgz(), { filename: 'wishlist.tgz' })
      .expect(200);

    expect(res.body.compatible).toBe(true);
    expect(res.body.requestedPermissions).toEqual(['read:products', 'read:categories']);
    expect(res.body.requestedSlots).toEqual([
      { slot: 'product-page', component: 'wishlist-button' },
    ]);
    // nothing persisted, and the inspect temp dir was cleaned up.
    const rows = await h.db.select().from(installedModules);
    expect(rows).toHaveLength(0);
    expect(fs.existsSync(path.join(modulesRoot(), 'wishlist'))).toBe(false);
  });

  // ── RBAC: staff is fail-closed ────────────────────────────────────────────────

  it('staff (no modules:* perms) → 403 on install AND inspect', async () => {
    const staff = await seedAdmin(h, { role: 'staff' });
    const token = await login(h, staff.email, staff.password);

    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', '[]')
      .attach('file', validTgz(), { filename: 'wishlist.tgz' })
      .expect(403);

    await request(h.http())
      .post(`${BASE}/inspect`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', validTgz(), { filename: 'wishlist.tgz' })
      .expect(403);

    // nothing was persisted by the rejected request.
    const rows = await h.db.select().from(installedModules);
    expect(rows).toHaveLength(0);
  });

  it('an unauthenticated request → 401', async () => {
    await request(h.http()).get(BASE).expect(401);
  });

  // ── tenant isolation ──────────────────────────────────────────────────────────

  it("tenant-2 cannot SEE or UNINSTALL tenant-1's installed module", async () => {
    // tenant-1 installs.
    const admin1 = await seedAdmin(h, { role: 'admin' });
    const token1 = await login(h, admin1.email, admin1.password);
    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token1}`)
      .field('grantedPermissions', JSON.stringify(['read:products']))
      .attach('file', validTgz(), { filename: 'wishlist.tgz' })
      .expect(201);

    // a SECOND tenant + admin (do not re-point the default tenant; seed directly).
    const admin2 = await seedAdmin(h, { role: 'admin' });
    // admin2 must log in against ITS OWN tenant — re-point default + token.
    // Simpler: assert via the DB + the token1 listing only shows tenant-1, and a delete
    // by a different tenant 404s. We verify isolation at the repository boundary by
    // listing as token1 (sees its module) and checking tenant-2 has no rows.
    const list1 = await request(h.http())
      .get(BASE)
      .set('Authorization', `Bearer ${token1}`)
      .expect(200);
    expect(list1.body).toHaveLength(1);
    expect(list1.body[0].name).toBe('wishlist');

    // tenant-2 has nothing of its own.
    const t2rows = await h.db
      .select()
      .from(installedModules)
      .where(eq(installedModules.tenantId, admin2.tenantId));
    expect(t2rows).toHaveLength(0);

    // A delete scoped to tenant-2 must not remove tenant-1's row: call the repo path via a
    // tenant-2 token. Re-point default tenant to admin2 + log in as admin2.
    await h.client`
      insert into system_state (key, value)
      values ('default_tenant_id', to_jsonb(${admin2.tenantId}::text))
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
    type Cached = { defaultTenantId: string | null };
    const { AuthService } = await import('../../../src/auth/services/auth.service');
    (h.app.get(AuthService, { strict: false }) as unknown as Cached).defaultTenantId = null;
    const token2 = await login(h, admin2.email, admin2.password);

    // tenant-2 sees NO modules, and uninstalling 'wishlist' → 404 (it's tenant-1's).
    const list2 = await request(h.http())
      .get(BASE)
      .set('Authorization', `Bearer ${token2}`)
      .expect(200);
    expect(list2.body).toHaveLength(0);

    await request(h.http())
      .delete(`${BASE}/wishlist`)
      .set('Authorization', `Bearer ${token2}`)
      .expect(404);

    // tenant-1's row survived the cross-tenant delete attempt.
    const stillThere = await h.db
      .select()
      .from(installedModules)
      .where(
        and(eq(installedModules.tenantId, admin1.tenantId), eq(installedModules.name, 'wishlist')),
      );
    expect(stillThere).toHaveLength(1);
  });

  // ── list + uninstall ──────────────────────────────────────────────────────────

  it('GET lists installed modules; DELETE uninstalls and removes the per-module dir', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);
    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', JSON.stringify(['read:products']))
      .attach('file', validTgz(), { filename: 'wishlist.tgz' })
      .expect(201);

    // the per-module dir exists after install.
    expect(fs.existsSync(path.join(modulesRoot(), 'wishlist'))).toBe(true);

    const list = await request(h.http())
      .get(BASE)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('wishlist');
    expect(list.body[0].grantedPermissions).toEqual(['read:products']);

    await request(h.http())
      .delete(`${BASE}/wishlist`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    // row gone + dir removed (no orphan).
    const rows = await h.db.select().from(installedModules);
    expect(rows).toHaveLength(0);
    expect(fs.existsSync(path.join(modulesRoot(), 'wishlist'))).toBe(false);

    // uninstalling again → 404.
    await request(h.http())
      .delete(`${BASE}/wishlist`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  // ── double-install → 409 (no update / no silent overwrite) ─────────────────────

  it('a second install of the same module → 409, with the first row UNCHANGED', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);

    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', JSON.stringify(['read:products']))
      .attach('file', validTgz(), { filename: 'wishlist.tgz' })
      .expect(201);

    // second install grants MORE perms — must be REFUSED, not applied as an update.
    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', JSON.stringify(['read:products', 'read:categories']))
      .attach('file', validTgz(), { filename: 'wishlist.tgz' })
      .expect(409);

    const rows = await h.db
      .select()
      .from(installedModules)
      .where(eq(installedModules.tenantId, admin.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.grantedPermissions).toEqual(['read:products']); // unchanged by the refused install
  });

  it('a same-name re-install with DIFFERENT content → 409 and does NOT swap the on-disk files', async () => {
    // Regression: a second install of a DIFFERENT tarball that declares an already-installed
    // `name` must NOT destroy + replace the existing module's on-disk files on its way to the
    // 409. We claim the (tenant, name) row BEFORE placing files, so a conflict never reaches
    // the placement step.
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);

    const legitTgz = validTgz({}, [{ name: 'package/payload.txt', data: Buffer.from('LEGIT') }]);
    const attackerTgz = validTgz({}, [
      { name: 'package/payload.txt', data: Buffer.from('ATTACKER') },
    ]);
    const payloadPath = path.join(modulesRoot(), 'wishlist', 'payload.txt');

    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', JSON.stringify(['read:products']))
      .attach('file', legitTgz, { filename: 'wishlist.tgz' })
      .expect(201);
    expect(fs.readFileSync(payloadPath, 'utf8')).toBe('LEGIT');

    // Attacker re-uploads a same-named tarball with different file content.
    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', JSON.stringify(['read:products']))
      .attach('file', attackerTgz, { filename: 'wishlist.tgz' })
      .expect(409);

    // The on-disk files are STILL the legitimate ones — never swapped.
    expect(fs.readFileSync(payloadPath, 'utf8')).toBe('LEGIT');
  });

  // ── NO code execution ─────────────────────────────────────────────────────────

  it('install does NOT execute module code (a postinstall-marker tarball → no marker)', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);

    const marker = path.join(modulesRoot(), `PWNED_${Date.now()}`);
    const pkgJson = JSON.stringify({
      name: 'wishlist',
      version: '1.2.3',
      scripts: { postinstall: `node -e "require('fs').writeFileSync('${marker}','x')"` },
    });
    const tgz = validTgz({}, [{ name: 'package/package.json', data: Buffer.from(pkgJson) }]);

    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', JSON.stringify(['read:products']))
      .attach('file', tgz, { filename: 'wishlist.tgz' })
      .expect(201);

    // the postinstall NEVER ran — install only extracts + persists.
    expect(fs.existsSync(marker)).toBe(false);
  });

  // ── verification failures → clean 4xx ──────────────────────────────────────────

  it('an incompatible-core manifest → 422 (no row persisted)', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);

    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', '[]')
      .attach('file', validTgz({ compatibleCore: '^2.0.0' }), { filename: 'wishlist.tgz' })
      .expect(422);

    expect(await h.db.select().from(installedModules)).toHaveLength(0);
  });

  it('a manifest declaring a permission OUTSIDE the allowlist → 422', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);

    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', '[]')
      .attach('file', validTgz({ permissions: ['read:products', 'delete:everything'] }), {
        filename: 'wishlist.tgz',
      })
      .expect(422);
  });

  it('a malformed (non-gzip) tarball → a clean 4xx, nothing persisted', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);

    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', '[]')
      .attach('file', Buffer.from('this is not a tarball'), { filename: 'junk.tgz' })
      .expect(422);

    expect(await h.db.select().from(installedModules)).toHaveLength(0);
  });

  it('a missing file → 400', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);
    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', '[]')
      .expect(400);
  });

  it('a non-array grantedPermissions field → 400', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);
    await request(h.http())
      .post(`${BASE}/install`)
      .set('Authorization', `Bearer ${token}`)
      .field('grantedPermissions', '{"not":"an array"}')
      .attach('file', validTgz(), { filename: 'wishlist.tgz' })
      .expect(400);
  });
});
