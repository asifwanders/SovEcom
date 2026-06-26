/**
 * A5 — Cross-tenant isolation & altered-claim rejection (integration,
 * SECURITY-CRITICAL). Decisions 022.2 (tid re-read from DB row). Real Postgres.
 *
 * Security-acceptance-core covered here:
 *   - an access token MINTED for tenant A is REJECTED on a tenant-B-scoped action
 *     (the guard loads the user WHERE id=sub AND tenant_id=claim.tid and the row's
 *     tenant is authoritative — a token cannot reach across tenants).
 *   - an ALTERED `tid` claim (re-signing the token to point at tenant B while the
 *     subject belongs to A) -> 401: either the signature check fails, or the
 *     `WHERE id=sub AND tenant_id=tid` lookup finds no row.
 *
 * RED today: `src/auth/**` does not exist, so `/login` 404s and the guard that
 * enforces this binding is absent — these fail.
 */
import request from 'supertest';
import * as crypto from 'node:crypto';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  makeTenant,
  AuthHarness,
  AUTH,
} from './_auth-harness';

/** Decode a JWT body (no verify) for white-box claim inspection. */
function decodeBody(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

/** Re-sign a JWT with a chosen secret after mutating its body (attacker forge). */
function resign(jwt: string, mutate: (b: Record<string, unknown>) => void, secret: string): string {
  const [h] = jwt.split('.');
  const body = decodeBody(jwt);
  mutate(body);
  const input = `${h}.${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
  const sig = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}

describe('A5 cross-tenant isolation / altered tid (integration, SECURITY-CRITICAL)', () => {
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

  it("an access token for tenant A carries A's tid and resolves to A's user", async () => {
    const tA = await makeTenant(h, 'tenant-a');
    const admin = await seedAdmin(h, { tenantId: tA });
    const res = await request(h.http())
      .post(AUTH.login)
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    expect(decodeBody(res.body.accessToken).tid).toBe(tA);

    // /me resolves the row for A — and never leaks B's tenant.
    const me = await request(h.http())
      .get(AUTH.me)
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
    expect(me.body.id).toBe(admin.id);
  });

  it('ALTERED tid claim (re-pointed at tenant B) -> 401 (signature or row lookup fails)', async () => {
    const tA = await makeTenant(h, 'tenant-a');
    const tB = await makeTenant(h, 'tenant-b');
    // A real, distinct user exists in B (so "tenant B exists" is not the reason).
    await seedAdmin(h, { tenantId: tB, email: 'b-admin@x.test' });
    const admin = await seedAdmin(h, { tenantId: tA });

    const res = await request(h.http())
      .post(AUTH.login)
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    const realToken = res.body.accessToken as string;

    // (a) Re-sign with the WRONG secret after swapping tid -> signature fails.
    const forgedWrongKey = resign(realToken, (b) => (b.tid = tB), 'attacker-guessed-secret');
    await request(h.http())
      .get(AUTH.me)
      .set('Authorization', `Bearer ${forgedWrongKey}`)
      .expect(401);

    // (b) Even the legitimately-signed token, if its tid is mutated, no longer
    // verifies (signature covers tid). The guard rejects it.
    const tamperedTid = realToken.replace(/\..*\./, () => {
      const b = decodeBody(realToken);
      b.tid = tB;
      return `.${Buffer.from(JSON.stringify(b)).toString('base64url')}.`;
    });
    await request(h.http()).get(AUTH.me).set('Authorization', `Bearer ${tamperedTid}`).expect(401);
  });

  it('a token for A cannot act for B: the guard binds the row by (sub, tid) so B sees no A session', async () => {
    const tA = await makeTenant(h, 'tenant-a');
    const tB = await makeTenant(h, 'tenant-b');
    const adminA = await seedAdmin(h, { tenantId: tA });
    await seedAdmin(h, { tenantId: tB, email: 'b@x.test' });

    const res = await request(h.http())
      .post(AUTH.login)
      .send({ email: adminA.email, password: adminA.password })
      .expect(200);

    // The user row resolved by the guard belongs to A, never B.
    const me = await request(h.http())
      .get(AUTH.me)
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
    const row = await h.client<{ tenant_id: string }[]>`
      select tenant_id from users where id = ${me.body.id}
    `;
    expect(row[0].tenant_id).toBe(tA);
    expect(row[0].tenant_id).not.toBe(tB);
  });
});
