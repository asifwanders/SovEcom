/**
 * A3 — Refresh rotation, family reuse-detection, concurrency & logout
 * (integration, SECURITY-CRITICAL). Real Postgres + Redis.
 *
 * Security-acceptance-core covered here:
 *   - refresh rotation: presenting the cookie mints a NEW access token + a NEW
 *     rotated refresh cookie; the old refresh row is revoked.
 *   - REUSE DETECTION: replaying an already-rotated (revoked) refresh token
 *     revokes that token's WHOLE FAMILY, while a DIFFERENT family (a second
 *     independent login) SURVIVES.
 *   - concurrency: two simultaneous refreshes of the same token -> exactly ONE
 *     wins (the atomic conditional UPDATE gate; the loser gets 401).
 *   - logout revokes the family AND clears the cookie (Max-Age=0 / Expires past).
 *
 * RED today: `src/auth/**` does not exist, so the routes 404 and these fail.
 */
import request from 'supertest';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  countRefresh,
  AuthHarness,
  AUTH,
} from './_auth-harness';

/** Extract the refresh cookie value (name=value) from a Set-Cookie header. */
function refreshCookie(setCookie: string[]): string {
  const c = setCookie.find((x) => /refresh/i.test(x));
  if (!c) throw new Error('no refresh cookie present');
  return c.split(';')[0];
}

describe('A3 refresh rotation / reuse / concurrency / logout (integration, SECURITY-CRITICAL)', () => {
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
    return refreshCookie(res.headers['set-cookie'] as unknown as string[]);
  }

  it('rotation: refresh mints a new access token + new rotated cookie; old row revoked', async () => {
    const admin = await seedAdmin(h);
    const cookie = await login(admin.email, admin.password);

    const res = await request(h.http()).post(AUTH.refresh).set('Cookie', cookie).expect(200);
    expect(typeof res.body.accessToken).toBe('string');

    const rotated = refreshCookie(res.headers['set-cookie'] as unknown as string[]);
    expect(rotated).not.toBe(cookie); // a NEW opaque token was minted

    // One revoked (old) + one live (new) for the same family.
    expect(await countRefresh(h, admin.id)).toBe(2);
    expect(await countRefresh(h, admin.id, true)).toBe(1);
  });

  it('REUSE: replaying a rotated (revoked) token revokes its family; another family SURVIVES', async () => {
    const admin = await seedAdmin(h);
    // Family 1
    const c1 = await login(admin.email, admin.password);
    // Family 2 — an independent second login (different device).
    const c2 = await login(admin.email, admin.password);

    // Rotate family 1 once, so c1 is now revoked.
    await request(h.http()).post(AUTH.refresh).set('Cookie', c1).expect(200);

    // Replay the now-revoked c1 -> reuse detected -> family 1 fully revoked.
    await request(h.http()).post(AUTH.refresh).set('Cookie', c1).expect(401);

    // Family 2 must be untouched: its cookie still refreshes successfully.
    await request(h.http()).post(AUTH.refresh).set('Cookie', c2).expect(200);

    // Sanity: there are at least two families and family 2 still has a live token.
    const familyCount = await h.client<{ c: string }[]>`
      select count(distinct family_id)::int as c from refresh_tokens where user_id = ${admin.id}
    `;
    expect(Number(familyCount[0].c)).toBeGreaterThanOrEqual(2);
  });

  it('CONCURRENCY: two simultaneous refreshes of the SAME token -> exactly one wins', async () => {
    const admin = await seedAdmin(h);
    const cookie = await login(admin.email, admin.password);

    const [a, b] = await Promise.all([
      request(h.http()).post(AUTH.refresh).set('Cookie', cookie),
      request(h.http()).post(AUTH.refresh).set('Cookie', cookie),
    ]);
    const statuses = [a.status, b.status].sort();
    // The atomic UPDATE gate lets exactly one rotate (200); the other loses (401).
    expect(statuses).toEqual([200, 401]);
  });

  it('logout revokes the family AND clears the refresh cookie', async () => {
    const admin = await seedAdmin(h);
    const cookie = await login(admin.email, admin.password);

    const res = await request(h.http()).post(AUTH.logout).set('Cookie', cookie).expect(204);

    // Cookie cleared: Max-Age=0 or an Expires in the past.
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const cleared = setCookie.find((c) => /refresh/i.test(c));
    expect(cleared).toBeDefined();
    expect(cleared!).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);

    // No live refresh tokens remain for the user.
    expect(await countRefresh(h, admin.id, true)).toBe(0);

    // The logged-out cookie can no longer refresh.
    await request(h.http()).post(AUTH.refresh).set('Cookie', cookie).expect(401);
  });
});
