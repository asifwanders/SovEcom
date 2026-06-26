/**
 * A2 — 2FA login challenge + disable (integration, SECURITY-CRITICAL).
 * Real Postgres + Redis, full Nest app.
 *
 * Security-acceptance-core covered here:
 *   - a 2FA-enabled user's `/login` returns NO tokens, only {requires2FA, challengeId}.
 *   - `/2fa` with a MISSING code -> 400/401 (no tokens); with a WRONG code -> 401
 *     (no tokens); with the CORRECT live TOTP -> 200 {accessToken} + refresh cookie.
 *   - disable-2FA requires BOTH password AND a fresh TOTP (one factor alone fails).
 *
 * RED today: `src/auth/**` does not exist, so the routes 404 and these fail.
 */
import request from 'supertest';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  totpNow,
  totpNext,
  AuthHarness,
  AUTH,
} from './_auth-harness';

describe('A2 2FA challenge / disable (integration, SECURITY-CRITICAL)', () => {
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

  async function loginToChallenge(email: string, password: string): Promise<string> {
    const res = await request(h.http()).post(AUTH.login).send({ email, password }).expect(200);
    expect(res.body.requires2FA).toBe(true);
    expect(typeof res.body.challengeId).toBe('string');
    // The first step must NOT hand out any access token.
    expect(res.body.accessToken).toBeUndefined();
    return res.body.challengeId as string;
  }

  it('login for a 2FA user returns {requires2FA, challengeId} and NO tokens', async () => {
    const admin = await seedAdmin(h, { withTotp: true });
    await loginToChallenge(admin.email, admin.password);
  });

  it('2FA with a WRONG code is rejected (401, no tokens)', async () => {
    const admin = await seedAdmin(h, { withTotp: true });
    const challengeId = await loginToChallenge(admin.email, admin.password);
    const res = await request(h.http())
      .post(AUTH.twoFa)
      .send({ challengeId, totpCode: '000000' })
      .expect(401);
    expect(res.body.accessToken).toBeUndefined();
  });

  it('2FA with a MISSING code is rejected by validation (no tokens)', async () => {
    const admin = await seedAdmin(h, { withTotp: true });
    const challengeId = await loginToChallenge(admin.email, admin.password);
    const res = await request(h.http()).post(AUTH.twoFa).send({ challengeId });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.accessToken).toBeUndefined();
  });

  it('2FA with the CORRECT live code returns {accessToken} + refresh cookie', async () => {
    const admin = await seedAdmin(h, { withTotp: true });
    const challengeId = await loginToChallenge(admin.email, admin.password);
    const res = await request(h.http())
      .post(AUTH.twoFa)
      .send({ challengeId, totpCode: totpNow(admin.totpSecret!) })
      .expect(200);
    expect(typeof res.body.accessToken).toBe('string');
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie.find((c) => /refresh/i.test(c))).toBeDefined();
  });

  it('disable-2FA requires BOTH password AND a fresh TOTP', async () => {
    const admin = await seedAdmin(h, { withTotp: true });
    // Get an access token via the full 2FA flow.
    const challengeId = await loginToChallenge(admin.email, admin.password);
    const { body } = await request(h.http())
      .post(AUTH.twoFa)
      .send({ challengeId, totpCode: totpNow(admin.totpSecret!) })
      .expect(200);
    const bearer = `Bearer ${body.accessToken}`;

    // password only -> rejected
    await request(h.http())
      .post(AUTH.disable)
      .set('Authorization', bearer)
      .send({ password: admin.password })
      .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));

    // wrong TOTP -> rejected
    await request(h.http())
      .post(AUTH.disable)
      .set('Authorization', bearer)
      .send({ password: admin.password, totpCode: '000000' })
      .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));

    // both correct -> 204; totp_enabled flips false. Use a FRESH (next-step) code:
    // the login above consumed the current step in the single-use replay guard.
    await request(h.http())
      .post(AUTH.disable)
      .set('Authorization', bearer)
      .send({ password: admin.password, totpCode: totpNext(admin.totpSecret!) })
      .expect(204);

    const rows = await h.client<{ totp_enabled: boolean }[]>`
      select totp_enabled from users where id = ${admin.id}
    `;
    expect(rows[0].totp_enabled).toBe(false);
  });

  it('re-enrolling while 2FA is ENABLED is rejected (no silent factor swap)', async () => {
    const admin = await seedAdmin(h, { withTotp: true });
    const challengeId = await loginToChallenge(admin.email, admin.password);
    const { body } = await request(h.http())
      .post(AUTH.twoFa)
      .send({ challengeId, totpCode: totpNow(admin.totpSecret!) })
      .expect(200);
    const bearer = `Bearer ${body.accessToken}`;

    // A bearer of the access token alone must NOT be able to start a re-enrollment
    // that would swap the active second factor.
    await request(h.http()).post(AUTH.enroll).set('Authorization', bearer).expect(409);

    // The active secret is untouched.
    const rows = await h.client<{ totp_enabled: boolean; totp_secret_pending: string | null }[]>`
      select totp_enabled, totp_secret_pending from users where id = ${admin.id}
    `;
    expect(rows[0].totp_enabled).toBe(true);
    expect(rows[0].totp_secret_pending).toBeNull();
  });
});
