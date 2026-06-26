/**
 * enable/disable/uninstall integration tests.
 *
 * Tests the new admin endpoints: POST …/:name/enable, POST …/:name/disable, and the
 * extended DELETE …/:name?dropData=true|false semantics against a REAL Postgres DB.
 *
 * What is NOT tested here (to keep the suite runnable without a compiled worker):
 *   - The happy-path enable (it forks dist/worker-entry.js which doesn't exist in tests).
 *
 * What IS tested:
 *   - staff → 403 on enable/disable (RBAC fail-closed);
 *   - enable a NOT-INSTALLED module → 404;
 *   - disable a not-running module → 204 (no-op, intent already satisfied);
 *   - uninstall with dropData=false → schema preserved (provisioned schema still exists);
 *   - uninstall with dropData=true  → schema dropped (deprovision was called).
 */
import request from 'supertest';
import * as zlib from 'zlib';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  AuthHarness,
  AUTH,
} from '../auth/_auth-harness';
import { ModuleDbProvisioner } from '../../../src/modules/runtime/module-db.provisioner';
import { schemaName } from '../../../src/modules/runtime/module-identifier';

const BASE = '/admin/v1/modules';

// ── minimal USTAR tar writer (mirrors modules.int-spec.ts) ─────────────────

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
      permissions: ['read:products'],
      slots: [],
      tables: [],
      ...overrides,
    }),
  );
}

function validTgz(extra: TarEntry[] = []): Buffer {
  return gzip(
    buildTar([
      { name: 'package/', type: '5' },
      { name: 'package/sovecom.module.json', data: manifestJson() },
      { name: 'package/index.js', data: Buffer.from('module.exports = {};\n') },
      ...extra,
    ]),
  );
}

async function login(h: AuthHarness, email: string, password: string): Promise<string> {
  const res = await request(h.http()).post(AUTH.login).send({ email, password }).expect(200);
  return res.body.accessToken as string;
}

/** Install the wishlist module for a tenant and return the admin token. */
async function installWishlist(h: AuthHarness): Promise<{ token: string; tenantId: string }> {
  const admin = await seedAdmin(h, { role: 'admin' });
  const token = await login(h, admin.email, admin.password);
  await request(h.http())
    .post(`${BASE}/install`)
    .set('Authorization', `Bearer ${token}`)
    .field('grantedPermissions', JSON.stringify(['read:products']))
    .attach('file', validTgz(), { filename: 'wishlist.tgz', contentType: 'application/gzip' })
    .expect(201);
  return { token, tenantId: admin.tenantId };
}

// ── suite ──────────────────────────────────────────────────────────────────

describe('Modules admin API — enable/disable/uninstall (integration)', () => {
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

  // ── RBAC: staff is fail-closed for enable/disable ──────────────────────────

  it('staff → 403 on POST enable AND disable', async () => {
    const staff = await seedAdmin(h, { role: 'staff' });
    const token = await login(h, staff.email, staff.password);

    await request(h.http())
      .post(`${BASE}/wishlist/enable`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    await request(h.http())
      .post(`${BASE}/wishlist/disable`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('unauthenticated → 401 on enable', async () => {
    await request(h.http()).post(`${BASE}/wishlist/enable`).expect(401);
  });

  // ── enable: 404 when module is not installed ───────────────────────────────

  it('enable a NOT-INSTALLED module → 404', async () => {
    const admin = await seedAdmin(h, { role: 'admin' });
    const token = await login(h, admin.email, admin.password);

    await request(h.http())
      .post(`${BASE}/ghost-module/enable`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  // ── disable: no-op when not running → 204 ─────────────────────────────────

  it('disable a module that is installed but not running → 204 (no-op)', async () => {
    // Install the module but don't enable it (workers only start explicitly via enable).
    const { token } = await installWishlist(h);

    // disable on a non-running module is a no-op — should still return 204.
    await request(h.http())
      .post(`${BASE}/wishlist/disable`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  });

  // ── uninstall with dropData semantics ──────────────────────────────────────

  it('uninstall with dropData=false keeps the DB schema (orphaned but recoverable)', async () => {
    // Provision the module DB home first so there is a schema to check.
    const { token, tenantId: _tenantId } = await installWishlist(h);
    const provisioner = h.app.get(ModuleDbProvisioner, { strict: false });
    await provisioner.provision('wishlist');

    // Uninstall WITHOUT dropData.
    await request(h.http())
      .delete(`${BASE}/wishlist`)
      .set('Authorization', `Bearer ${token}`)
      .query({ dropData: 'false' })
      .expect(204);

    // The schema must still exist.
    const schema = schemaName('wishlist'); // 'mod_wishlist'
    const rows = await h.client<{ nspname: string }[]>`
      SELECT nspname FROM pg_namespace WHERE nspname = ${schema}
    `;
    expect(rows).toHaveLength(1);

    // Clean up the schema so the DB is left tidy.
    await provisioner.deprovision('wishlist').catch(() => undefined);
  });

  it('uninstall with dropData=true removes the DB schema + role', async () => {
    const { token } = await installWishlist(h);
    const provisioner = h.app.get(ModuleDbProvisioner, { strict: false });
    await provisioner.provision('wishlist');

    const schema = schemaName('wishlist');
    // Confirm it exists before the test.
    const before = await h.client<{ nspname: string }[]>`
      SELECT nspname FROM pg_namespace WHERE nspname = ${schema}
    `;
    expect(before).toHaveLength(1);

    // Uninstall WITH dropData=true.
    await request(h.http())
      .delete(`${BASE}/wishlist`)
      .set('Authorization', `Bearer ${token}`)
      .query({ dropData: 'true' })
      .expect(204);

    // The schema must be gone.
    const after = await h.client<{ nspname: string }[]>`
      SELECT nspname FROM pg_namespace WHERE nspname = ${schema}
    `;
    expect(after).toHaveLength(0);
  });

  it('uninstall with no dropData param defaults to false (schema preserved)', async () => {
    const { token } = await installWishlist(h);
    const provisioner = h.app.get(ModuleDbProvisioner, { strict: false });
    await provisioner.provision('wishlist');

    // Uninstall with no query param.
    await request(h.http())
      .delete(`${BASE}/wishlist`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const schema = schemaName('wishlist');
    const rows = await h.client<{ nspname: string }[]>`
      SELECT nspname FROM pg_namespace WHERE nspname = ${schema}
    `;
    expect(rows).toHaveLength(1);

    // Clean up.
    await provisioner.deprovision('wishlist').catch(() => undefined);
  });
});
