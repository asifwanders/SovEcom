/**
 * Setup token + boot + endpoints integration (SECURITY-CRITICAL).
 * Real Postgres + Redis.
 *
 * Covers:
 *   - boot (not installed) mints exactly one live token (~24h expiry, unused);
 *   - boot (installed) mints nothing;
 *   - GET /status reflects installed true/false (+ requiresToken = !installed);
 *   - POST /verify-token: live → {valid,expiresAt}, garbage/expired/used → invalid;
 *   - verify-token does NOT consume (idempotent);
 *   - regenerate-on-restart: a second not-installed boot supersedes the prior token;
 *   - SQL-level verify/consume against REAL Postgres (live/expired/used, single-use);
 *   - NO TOKEN LEAK: the plaintext never appears in any API response body.
 *
 * The plaintext token is obtained for assertions ONLY via the service's
 * generateToken() return (the same value the banner prints). The banner itself is
 * not asserted here — it goes to stdout and the automatic path is test-suppressed.
 */
import request from 'supertest';
import { createHash } from 'node:crypto';
import {
  bootSetupApp,
  teardownSetupApp,
  resetSetupState,
  setInstalled,
  runBoot,
  countTokens,
  liveTokenRow,
  SETUP,
  type SetupHarness,
} from './_setup-harness';

/** Local SHA-256 helper (mirrors the service hashing) for targeting a specific row. */
function sha(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

describe('Setup token + boot + endpoints (integration, SECURITY-CRITICAL)', () => {
  let h: SetupHarness;

  beforeAll(async () => {
    h = await bootSetupApp();
  });

  afterAll(async () => {
    await teardownSetupApp(h);
  });

  beforeEach(async () => {
    await resetSetupState(h);
  });

  // ─── Boot sequence ────────────────────────────────────────────────────────

  it('boot (not installed) mints exactly one live, unused token with a ~24h expiry', async () => {
    await setInstalled(h, false);
    await runBoot(h);

    expect(await countTokens(h)).toBe(1);
    const row = await liveTokenRow(h);
    expect(row).not.toBeNull();
    expect(row!.used_at).toBeNull();

    const ttlMs = row!.expires_at.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 60 * 60 * 1000); // > 23h
    expect(ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 60_000); // <= 24h + slack
  });

  it('boot treats an ABSENT installed key (no seed) as not-installed and mints a token', async () => {
    await setInstalled(h, undefined);
    await runBoot(h);
    expect(await countTokens(h)).toBe(1);
  });

  it('boot (installed=true) mints NO token', async () => {
    await setInstalled(h, true);
    await runBoot(h);
    expect(await countTokens(h)).toBe(0);
  });

  it('regenerate-on-restart: a second not-installed boot supersedes the prior token (one live)', async () => {
    await setInstalled(h, false);
    await runBoot(h);
    const firstHash = (await liveTokenRow(h))!.token_hash;

    await runBoot(h); // simulate container restart while still not-installed
    expect(await countTokens(h, true)).toBe(1); // exactly one LIVE token
    expect(await countTokens(h)).toBe(2); // prior row retained but superseded
    const secondHash = (await liveTokenRow(h))!.token_hash;
    expect(secondHash).not.toBe(firstHash);
  });

  // ─── GET /status ────────────────────────────────────────────────────────────

  it('GET /status reports not-installed (+ requiresToken:true) when not installed', async () => {
    await setInstalled(h, false);
    const res = await request(h.http()).get(SETUP.status).expect(200);
    expect(res.body).toEqual({ installed: false, requiresToken: true });
  });

  it('GET /status reports installed (+ requiresToken:false) when installed', async () => {
    await setInstalled(h, true);
    const res = await request(h.http()).get(SETUP.status).expect(200);
    expect(res.body).toEqual({ installed: true, requiresToken: false });
  });

  // ─── POST /verify-token ──────────────────────────────────────────────────────

  it('POST /verify-token 404s post-install (setup surface closed except GET /status)', async () => {
    await setInstalled(h, true);
    // 404 BEFORE any token processing — hide-existence posture, consistent with the guard
    // (independent + mimo review: close the literal "reject all except /status" gap).
    await request(h.http()).post(SETUP.verify).send({ token: 'anything' }).expect(404);
    // GET /status remains the one open endpoint.
    await request(h.http()).get(SETUP.status).expect(200);
  });

  it('POST /verify-token returns {valid:true, expiresAt} for a live token and does NOT consume it', async () => {
    await setInstalled(h, false);
    const token = await h.tokens.generateToken(); // plaintext, as the banner prints

    const res = await request(h.http()).post(SETUP.verify).send({ token }).expect(200);
    expect(res.body.valid).toBe(true);
    expect(typeof res.body.expiresAt).toBe('string');
    expect(Date.parse(res.body.expiresAt)).not.toBeNaN();

    // Idempotent: still unused, and a second verify still passes.
    expect((await liveTokenRow(h))!.used_at).toBeNull();
    const again = await request(h.http()).post(SETUP.verify).send({ token }).expect(200);
    expect(again.body.valid).toBe(true);
  });

  it('POST /verify-token returns {valid:false, expiresAt:null} for a garbage token', async () => {
    await setInstalled(h, false);
    const res = await request(h.http())
      .post(SETUP.verify)
      .send({ token: 'totally-not-a-real-token' })
      .expect(200);
    expect(res.body).toEqual({ valid: false, expiresAt: null });
  });

  it('POST /verify-token rejects a malformed body (missing token) with a 400', async () => {
    await setInstalled(h, false);
    await request(h.http()).post(SETUP.verify).send({}).expect(400);
  });

  it('POST /verify-token returns invalid for an EXPIRED token', async () => {
    await setInstalled(h, false);
    const token = await h.tokens.generateToken();
    await h.client`update setup_tokens set expires_at = now() - interval '1 second'`;
    const res = await request(h.http()).post(SETUP.verify).send({ token }).expect(200);
    expect(res.body).toEqual({ valid: false, expiresAt: null });
  });

  it('POST /verify-token returns invalid for a USED token', async () => {
    await setInstalled(h, false);
    const token = await h.tokens.generateToken();
    expect(await h.tokens.consumeToken(token)).toBe(true);
    const res = await request(h.http()).post(SETUP.verify).send({ token }).expect(200);
    expect(res.body).toEqual({ valid: false, expiresAt: null });
  });

  // ─── SQL-level verify/consume against real Postgres ──────────────────────────

  it('verifyToken (service) accepts live, rejects expired + used + unknown', async () => {
    const token = await h.tokens.generateToken();
    expect((await h.tokens.verifyToken(token)).valid).toBe(true);

    // expired
    const expired = await h.tokens.generateToken();
    await h.client`update setup_tokens set expires_at = now() - interval '1 second' where token_hash = ${sha(expired)}`;
    expect((await h.tokens.verifyToken(expired)).valid).toBe(false);

    // unknown
    expect((await h.tokens.verifyToken('nope')).valid).toBe(false);
  });

  it('consumeToken is single-use: a second consume of the same token fails', async () => {
    const token = await h.tokens.generateToken();
    expect(await h.tokens.consumeToken(token)).toBe(true);
    expect(await h.tokens.consumeToken(token)).toBe(false);
  });

  it('consumeToken rejects an expired token', async () => {
    const token = await h.tokens.generateToken();
    await h.client`update setup_tokens set expires_at = now() - interval '1 second'`;
    expect(await h.tokens.consumeToken(token)).toBe(false);
  });

  // ─── No token leak ───────────────────────────────────────────────────────────

  it('NO TOKEN LEAK: the plaintext token never appears in any API response body', async () => {
    await setInstalled(h, false);
    const token = await h.tokens.generateToken();

    const status = await request(h.http()).get(SETUP.status).expect(200);
    const verifyOk = await request(h.http()).post(SETUP.verify).send({ token }).expect(200);
    const verifyBad = await request(h.http())
      .post(SETUP.verify)
      .send({ token: 'wrong' })
      .expect(200);

    for (const res of [status, verifyOk, verifyBad]) {
      expect(JSON.stringify(res.body)).not.toContain(token);
    }
  });
});
