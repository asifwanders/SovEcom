/**
 * TokenService UNIT tests (no DB/Redis, `jest.config.js`).
 * SECURITY-CRITICAL.
 *
 * Pure JWT issue/verify + opaque-refresh minting. No Postgres, no Redis — the
 * service is constructed against a tiny config stub that returns a fixed
 * `JWT_SECRET`, so these run in the fast unit suite.
 *
 * Covers:
 *   - issue + verify round-trips an access token; payload carries {sub,tid,role,tv}.
 *   - ALG-PINNING: a token forged with `alg:none` is rejected; a token signed
 *     under a *different algorithm family* (RS256) is rejected; a tampered
 *     (bit-flipped signature/body) HS256 token is rejected.
 *   - a token that is NOT an access token (carries a non-access `purpose`/`aud`,
 *     e.g. a 2fa-challenge or refresh-purpose token) is rejected by
 *     `verifyAccessToken`.
 *   - opaque refresh: 64-byte CSPRNG, hash is sha256 of plaintext, plaintext is
 *     never the stored hash.
 *
 * RED today: `./token.service` does not exist yet, so this fails to COMPILE.
 * That is the expected failing-first state (write tests first, then code).
 */
import * as crypto from 'node:crypto';
import { TokenService } from './token.service';

/** A 256-bit dev secret — long enough to satisfy the prod strength gate. */
const SECRET = 'unit-test-secret-unit-test-secret-unit-test-secret-32+';

/**
 * Minimal config seam: the service reads `JWT_SECRET` via an indirection
 * (`getSigningKey()`), so a stub `ConfigService`-shaped get() is all we inject.
 */
function makeService(): TokenService {
  const config = {
    get: (key: string): string | undefined => (key === 'JWT_SECRET' ? SECRET : undefined),
  };
  // The real ctor takes (ConfigService). The stub satisfies the .get() it uses.
  return new TokenService(config as never);
}

const USER = {
  id: '00000000-0000-7000-8000-000000000001',
  tenantId: '00000000-0000-7000-8000-0000000000aa',
  role: 'admin' as const,
  tokenVersion: 3,
};

/** Decode a JWT body without verifying (for white-box payload assertions). */
function decodeBody(jwt: string): Record<string, unknown> {
  const body = jwt.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

/** Hand-forge a JWT with an arbitrary header+payload and an attacker signature. */
function forge(header: object, payload: object, sig = ''): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.${sig}`;
}

describe('TokenService — access JWT issue/verify (unit, SECURITY-CRITICAL)', () => {
  let svc: TokenService;
  beforeEach(() => {
    svc = makeService();
  });

  it('issues an access token that verifies and carries {sub,tid,role,tv}', async () => {
    const token = await svc.issueAccessToken(USER);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);

    const claims = await svc.verifyAccessToken(token);
    expect(claims.sub).toBe(USER.id);
    expect(claims.tid).toBe(USER.tenantId);
    expect(claims.role).toBe(USER.role);
    expect(claims.tv).toBe(USER.tokenVersion);
  });

  it('the access payload pins HS256 in its header', async () => {
    const token = await svc.issueAccessToken(USER);
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
    expect(header.alg).toBe('HS256');
  });

  // ---- ALG-PINNING: the load-bearing security assertions ----

  it('ALG-PIN: rejects an `alg:none` forged token (no signature)', async () => {
    const body = { ...decodeBody(await svc.issueAccessToken(USER)) };
    const forged = forge({ alg: 'none', typ: 'JWT' }, body, '');
    await expect(svc.verifyAccessToken(forged)).rejects.toThrow();
  });

  it('ALG-PIN: rejects a token signed with an asymmetric alg (RS256) instead of HS256', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const body = { ...decodeBody(await svc.issueAccessToken(USER)) };
    const header = { alg: 'RS256', typ: 'JWT' };
    const signingInput =
      Buffer.from(JSON.stringify(header)).toString('base64url') +
      '.' +
      Buffer.from(JSON.stringify(body)).toString('base64url');
    const sig = crypto
      .createSign('RSA-SHA256')
      .update(signingInput)
      .sign(privateKey)
      .toString('base64url');
    const rsToken = `${signingInput}.${sig}`;
    await expect(svc.verifyAccessToken(rsToken)).rejects.toThrow();
  });

  it('ALG-PIN: rejects a tampered HS256 token (mutated payload, stale signature)', async () => {
    const token = await svc.issueAccessToken(USER);
    const [h, , s] = token.split('.');
    const tampered = { ...decodeBody(token), role: 'owner' }; // privilege bump attempt
    const evil = `${h}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${s}`;
    await expect(svc.verifyAccessToken(evil)).rejects.toThrow();
  });

  it('rejects a garbage/structurally-invalid token', async () => {
    await expect(svc.verifyAccessToken('not-a-jwt')).rejects.toThrow();
  });

  // ---- token-kind confusion: only access tokens pass verifyAccessToken ----

  it('rejects a token that is NOT an access token (2fa-challenge purpose) — token confusion', async () => {
    // Sign a structurally-valid HS256 token with the SAME secret but a non-access
    // purpose. It must NOT be accepted as an access token.
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
      sub: USER.id,
      tid: USER.tenantId,
      purpose: '2fa-challenge',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    const input =
      Buffer.from(JSON.stringify(header)).toString('base64url') +
      '.' +
      Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(input).digest('base64url');
    const challengeToken = `${input}.${sig}`;
    await expect(svc.verifyAccessToken(challengeToken)).rejects.toThrow();
  });
});

describe('TokenService — opaque refresh minting (unit)', () => {
  let svc: TokenService;
  beforeEach(() => {
    svc = makeService();
  });

  it('mints a 64-byte CSPRNG plaintext whose stored value is sha256(plaintext), never the plaintext', () => {
    const { plaintext, hash } = svc.issueRefreshToken();
    // 64 bytes -> 128 hex chars (or 86 base64url) — assert it is high-entropy & long.
    expect(plaintext.length).toBeGreaterThanOrEqual(64);
    // The stored hash is sha256(plaintext) and is NOT the plaintext itself.
    const expected = crypto.createHash('sha256').update(plaintext).digest('hex');
    expect(hash).toBe(expected);
    expect(hash).not.toBe(plaintext);
  });

  it('two mints are distinct (CSPRNG, no collision)', () => {
    const a = svc.issueRefreshToken();
    const b = svc.issueRefreshToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});
