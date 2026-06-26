/**
 * A4 — Forgot / reset password (integration, SECURITY-CRITICAL).
 * Real Postgres + Redis, full Nest app.
 *
 * Security-acceptance-core covered here:
 *   - full flow: forgot -> a reset-token row is created (hash at rest) -> reset
 *     succeeds -> the password is changed -> ALL sessions are revoked AND
 *     `token_version` is bumped so a live access token minted before the reset is
 *     now REJECTED.
 *   - forgot for an UNKNOWN email still returns 202 (anti-enumeration).
 *   - per-DESTINATION-email cap: hammering forgot for one email (even from one IP)
 *     is rate-capped (independent of IP) — anti email-bombing.
 *   - reset single-use TOCTOU: two concurrent resets with the same token -> exactly
 *     ONE succeeds, the other fails.
 *
 * The harness reads the stored token_hash directly; the spec derives the
 * plaintext path by capturing it via a 32-byte CSPRNG round-trip. Because the
 * implementation hashes the token before storage, the spec mints a known token,
 * inserts its hash through the service's own forgot flow, and reads it back — for
 * the TOCTOU/consume assertions we exercise the public reset route with a token
 * whose hash we control by intercepting the MailService send (see harness notes).
 *
 * RED today: `src/auth/**` does not exist, so the routes 404 and these fail.
 */
import request from 'supertest';
import * as crypto from 'node:crypto';
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  seedAdmin,
  countRefresh,
  tokenVersion,
  latestResetHash,
  sha256,
  AuthHarness,
  AUTH,
} from './_auth-harness';

/**
 * The reset token is delivered by email and only its sha256 is stored. To drive
 * `/reset` from a test we must learn the plaintext. The auth module exposes a
 * test-only seam (NODE_ENV==='test'): when `RESET_TOKEN_SINK` is set, the most-recently-issued
 * plaintext reset token is mirrored into Redis at `test:last-reset-token:{userId}` so
 * the harness can read it WITHOUT weakening production (the sink is gated on
 * NODE_ENV==='test'). The spec reads it back.
 */
async function lastPlaintextResetToken(h: AuthHarness, userId: string): Promise<string> {
  const v = await h.redis.get(`test:last-reset-token:${userId}`);
  if (!v) throw new Error('reset token sink empty — is the test-only sink wired?');
  return v;
}

describe('A4 forgot / reset password (integration, SECURITY-CRITICAL)', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    process.env.RESET_TOKEN_SINK = '1';
    h = await bootAuthApp();
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });
  beforeEach(async () => {
    await resetAuthState(h);
  });

  it('forgot for an UNKNOWN email still returns 202 (anti-enumeration)', async () => {
    await request(h.http()).post(AUTH.forgot).send({ email: 'ghost@x.test' }).expect(202);
    // No row leaked for a non-existent user.
    const rows = await h.client<
      { c: string }[]
    >`select count(*)::int as c from password_reset_tokens`;
    expect(Number(rows[0].c)).toBe(0);
  });

  it('forgot stores only the token HASH at rest (never the plaintext)', async () => {
    const admin = await seedAdmin(h);
    await request(h.http()).post(AUTH.forgot).send({ email: admin.email }).expect(202);

    const storedHash = await latestResetHash(h, admin.id);
    expect(storedHash).not.toBeNull();
    const plaintext = await lastPlaintextResetToken(h, admin.id);
    // Stored value is sha256(plaintext) and is NOT the plaintext.
    expect(storedHash).toBe(sha256(plaintext));
    expect(storedHash).not.toBe(plaintext);
  });

  it('full flow: reset changes the password, revokes ALL sessions and kills a live access token', async () => {
    const admin = await seedAdmin(h);

    // Live session + a captured access token from BEFORE the reset.
    const login = await request(h.http())
      .post(AUTH.login)
      .send({ email: admin.email, password: admin.password })
      .expect(200);
    const staleAccess = `Bearer ${login.body.accessToken}`;
    expect(await countRefresh(h, admin.id, true)).toBeGreaterThanOrEqual(1);
    const tvBefore = await tokenVersion(h, admin.id);

    // Forgot -> capture token -> reset.
    await request(h.http()).post(AUTH.forgot).send({ email: admin.email }).expect(202);
    const token = await lastPlaintextResetToken(h, admin.id);
    await request(h.http())
      .post(AUTH.reset)
      .send({ token, newPassword: 'a brand new passphrase 12+' })
      .expect(204);

    // The OLD password no longer works.
    await request(h.http())
      .post(AUTH.login)
      .send({ email: admin.email, password: admin.password })
      .expect(401);

    // The reset itself revoked ALL pre-existing sessions and bumped token_version
    // (so the stale access token is now rejected). Assert this BEFORE the new-
    // password login below, which legitimately mints a fresh session of its own.
    expect(await countRefresh(h, admin.id, true)).toBe(0);
    expect(await tokenVersion(h, admin.id)).toBeGreaterThan(tvBefore);
    await request(h.http()).get(AUTH.me).set('Authorization', staleAccess).expect(401);

    // The NEW password works.
    await request(h.http())
      .post(AUTH.login)
      .send({ email: admin.email, password: 'a brand new passphrase 12+' })
      .expect(200);
  });

  it('per-DESTINATION-email cap stops IP-rotation bombing (independent of IP)', async () => {
    const admin = await seedAdmin(h);
    let capped = false;
    // Spoof a fresh client IP each time (trust proxy=1 honours the LAST XFF hop),
    // proving the cap keys on the destination email, not the source IP.
    for (let i = 0; i < 10; i++) {
      const res = await request(h.http())
        .post(AUTH.forgot)
        .set('X-Forwarded-For', `203.0.113.${i}`)
        .send({ email: admin.email });
      if (res.status === 429) capped = true;
    }
    expect(capped).toBe(true);
  });

  it('single-use TOCTOU: two concurrent resets with the same token -> exactly one succeeds', async () => {
    const admin = await seedAdmin(h);
    await request(h.http()).post(AUTH.forgot).send({ email: admin.email }).expect(202);
    const token = await lastPlaintextResetToken(h, admin.id);

    const [a, b] = await Promise.all([
      request(h.http()).post(AUTH.reset).send({ token, newPassword: 'first winner pw 12+++' }),
      request(h.http()).post(AUTH.reset).send({ token, newPassword: 'second winner pw 12+++' }),
    ]);
    const ok = [a, b].filter((r) => r.status === 204);
    const bad = [a, b].filter((r) => r.status !== 204);
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
  });

  it('a malformed reset body leaks neither the token nor the password in the response', async () => {
    const secretToken = crypto.randomBytes(32).toString('base64url');
    const res = await request(h.http())
      .post(AUTH.reset)
      .send({ token: secretToken, newPassword: 'short', extraField: 'x' }); // too-short + unknown
    expect(res.status).toBeGreaterThanOrEqual(400);
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain(secretToken);
    expect(blob).not.toContain('short');
  });
});
