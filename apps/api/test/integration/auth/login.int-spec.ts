/**
 * A1 — Login, lockout & enumeration-uniformity (integration, SECURITY-CRITICAL).
 * Decisions 022.4 / 022.7. Real Postgres + Redis, full Nest app.
 *
 * Security-acceptance-core covered here:
 *   - full login -> {accessToken} + httpOnly refresh cookie.
 *   - wrong-password increments failed_attempts and trips the SOFT lock.
 *   - LOCKED account (non-remote-lockable): a request with CORRECT creds still
 *     SUCCEEDS even while soft-locked (an attacker cannot DoS a victim out of
 *     their own valid credentials), while wrong creds on the locked account get
 *     the SAME uniform 401 as every other failure branch.
 *   - enumeration uniformity: unknown-email, wrong-password, and locked-wrong all
 *     return the identical status + body shape (no branch is distinguishable).
 *
 * RED today: `src/auth/**` does not exist, so the routes 404 and these fail.
 */
import request from 'supertest';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  AuthHarness,
  AUTH,
} from './_auth-harness';

describe('A1 login / lockout / enumeration (integration, SECURITY-CRITICAL)', () => {
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

  it('full login returns an access token and sets an httpOnly refresh cookie', async () => {
    const admin = await seedAdmin(h);
    const res = await request(h.http())
      .post(AUTH.login)
      .send({ email: admin.email, password: admin.password })
      .expect(200);

    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.accessToken.split('.')).toHaveLength(3);

    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(Array.isArray(setCookie)).toBe(true);
    const refresh = setCookie.find((c) => /refresh/i.test(c));
    expect(refresh).toBeDefined();
    expect(refresh!).toMatch(/HttpOnly/i);
    expect(refresh!).toMatch(/SameSite=Strict/i);
    expect(refresh!).toMatch(/Path=\/admin\/v1\/auth/i);
  });

  it('wrong password increments failed_attempts and trips the soft lock after 5', async () => {
    const admin = await seedAdmin(h);
    for (let i = 0; i < 5; i++) {
      await request(h.http())
        .post(AUTH.login)
        .send({ email: admin.email, password: 'wrong-password' })
        .expect(401);
    }
    const rows = await h.client<{ failed_attempts: number; locked_until: Date | null }[]>`
      select failed_attempts, locked_until from users where id = ${admin.id}
    `;
    expect(rows[0].failed_attempts).toBeGreaterThanOrEqual(5);
    expect(rows[0].locked_until).not.toBeNull();
  });

  it('LOCKED account: CORRECT creds still SUCCEED (non-remote-lockable)', async () => {
    const admin = await seedAdmin(h);
    // Trip the soft lock with an attacker's wrong guesses.
    for (let i = 0; i < 6; i++) {
      await request(h.http())
        .post(AUTH.login)
        .send({ email: admin.email, password: 'wrong-password' });
    }
    // The legitimate user, presenting the CORRECT password, must still get in.
    const res = await request(h.http())
      .post(AUTH.login)
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    expect(typeof res.body.accessToken).toBe('string');

    // Successful login resets the failure counter + clears the soft lock.
    const rows = await h.client<{ failed_attempts: number; locked_until: Date | null }[]>`
      select failed_attempts, locked_until from users where id = ${admin.id}
    `;
    expect(rows[0].failed_attempts).toBe(0);
    expect(rows[0].locked_until).toBeNull();
  });

  it('LOCKED account + WRONG creds returns the SAME uniform 401 as any other failure', async () => {
    const admin = await seedAdmin(h);
    for (let i = 0; i < 6; i++) {
      await request(h.http())
        .post(AUTH.login)
        .send({ email: admin.email, password: 'wrong-password' });
    }
    const lockedWrong = await request(h.http())
      .post(AUTH.login)
      .send({ email: admin.email, password: 'still-wrong' })
      .expect(401);

    const unknownEmail = await request(h.http())
      .post(AUTH.login)
      .send({ email: 'nobody@x.test', password: 'whatever' })
      .expect(401);

    const wrongPw = await (async () => {
      const a2 = await seedAdmin(h);
      return request(h.http())
        .post(AUTH.login)
        .send({ email: a2.email, password: 'nope' })
        .expect(401);
    })();

    // Identical body shape across all three failure branches (no enumeration).
    expect(lockedWrong.body).toEqual(unknownEmail.body);
    expect(unknownEmail.body).toEqual(wrongPw.body);
    // And the body must not leak which branch ran (no "locked"/"unknown user" text).
    const blob = JSON.stringify(lockedWrong.body).toLowerCase();
    expect(blob).not.toMatch(/lock|unknown|not found|no such/);
  });

  it('an unknown email never reveals existence (still a generic 401)', async () => {
    await request(h.http())
      .post(AUTH.login)
      .send({ email: 'ghost@x.test', password: 'x' })
      .expect(401);
  });
});
