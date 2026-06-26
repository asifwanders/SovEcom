/**
 * CustomerTokenService UNIT tests (no DB/Redis) (F10, SECURITY-CRITICAL).
 *
 * Mirrors `token.service.spec.ts` for the customer access-token kind. Covers:
 *   - issue + verify round-trips; payload carries {sub,tid,tv,purpose:'customer'}.
 *   - ALG-PINNING: `alg:none`, an asymmetric (RS256) signature, and a tampered
 *     HS256 token are all rejected.
 *   - PURPOSE-PINNING (the isolation hinge): an admin `purpose:'access'` token
 *     signed with the SAME secret is rejected here, and any other purpose too.
 *   - expiry: an already-expired customer token is rejected.
 *
 * The service reads `JWT_SECRET` through a ConfigService-shaped seam, so a tiny
 * stub is all that's injected — these run in the fast unit suite.
 */
import * as crypto from 'node:crypto';
import { CustomerTokenService } from './customer-token.service';

/** A 256-bit dev secret — the SAME secret both token kinds share (purpose separates). */
const SECRET = 'unit-test-secret-unit-test-secret-unit-test-secret-32+';

function makeService(): CustomerTokenService {
  const config = {
    get: (key: string): string | undefined => (key === 'JWT_SECRET' ? SECRET : undefined),
  };
  return new CustomerTokenService(config as never);
}

const CUSTOMER = {
  id: '00000000-0000-7000-8000-000000000001',
  tenantId: '00000000-0000-7000-8000-0000000000aa',
  tokenVersion: 0,
};

function decodeBody(jwt: string): Record<string, unknown> {
  const body = jwt.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

function forge(header: object, payload: object, sig = ''): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${p}.${sig}`;
}

/** HS256-sign an arbitrary payload with the SAME secret (cross-kind forgery). */
function hs256(payload: object): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const input =
    Buffer.from(JSON.stringify(header)).toString('base64url') +
    '.' +
    Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(input).digest('base64url');
  return `${input}.${sig}`;
}

describe('CustomerTokenService — access JWT issue/verify (unit, SECURITY-CRITICAL)', () => {
  let svc: CustomerTokenService;
  beforeEach(() => {
    svc = makeService();
  });

  it('issues a customer token that verifies and carries {sub,tid,tv,purpose:customer}', async () => {
    const token = await svc.issueAccessToken(CUSTOMER);
    expect(token.split('.')).toHaveLength(3);
    const claims = await svc.verifyAccessToken(token);
    expect(claims.sub).toBe(CUSTOMER.id);
    expect(claims.tid).toBe(CUSTOMER.tenantId);
    expect(claims.tv).toBe(CUSTOMER.tokenVersion);
    expect(claims.purpose).toBe('customer');
  });

  it('the customer payload carries NO role and pins HS256 in its header', async () => {
    const token = await svc.issueAccessToken(CUSTOMER);
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'));
    expect(header.alg).toBe('HS256');
    expect(decodeBody(token)).not.toHaveProperty('role');
  });

  // ---- ALG-PINNING ----

  it('ALG-PIN: rejects an `alg:none` forged token', async () => {
    const body = { ...decodeBody(await svc.issueAccessToken(CUSTOMER)) };
    const forged = forge({ alg: 'none', typ: 'JWT' }, body, '');
    await expect(svc.verifyAccessToken(forged)).rejects.toThrow();
  });

  it('ALG-PIN: rejects an RS256-signed token instead of HS256', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const body = { ...decodeBody(await svc.issueAccessToken(CUSTOMER)) };
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
    await expect(svc.verifyAccessToken(`${signingInput}.${sig}`)).rejects.toThrow();
  });

  it('ALG-PIN: rejects a tampered HS256 token (mutated payload, stale signature)', async () => {
    const token = await svc.issueAccessToken(CUSTOMER);
    const [h, , s] = token.split('.');
    const tampered = { ...decodeBody(token), sub: 'another-customer-id' };
    const evil = `${h}.${Buffer.from(JSON.stringify(tampered)).toString('base64url')}.${s}`;
    await expect(svc.verifyAccessToken(evil)).rejects.toThrow();
  });

  it('rejects a garbage/structurally-invalid token', async () => {
    await expect(svc.verifyAccessToken('not-a-jwt')).rejects.toThrow();
  });

  // ---- PURPOSE-PINNING: the cross-system isolation hinge ----

  it("rejects an admin purpose:'access' token signed with the SAME secret (token-kind confusion)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const adminAccess = hs256({
      sub: CUSTOMER.id,
      tid: CUSTOMER.tenantId,
      role: 'admin',
      tv: 0,
      purpose: 'access', // admin kind
      iat: now,
      exp: now + 900,
    });
    await expect(svc.verifyAccessToken(adminAccess)).rejects.toThrow();
  });

  it('rejects any other purpose (e.g. 2fa-challenge / refresh)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const other = hs256({
      sub: CUSTOMER.id,
      tid: CUSTOMER.tenantId,
      purpose: '2fa-challenge',
      iat: now,
      exp: now + 300,
    });
    await expect(svc.verifyAccessToken(other)).rejects.toThrow();
  });

  // ---- expiry ----

  it('rejects an already-expired customer token', async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = hs256({
      sub: CUSTOMER.id,
      tid: CUSTOMER.tenantId,
      tv: 0,
      purpose: 'customer',
      iat: past - 900,
      exp: past, // expired 10s ago
    });
    await expect(svc.verifyAccessToken(expired)).rejects.toThrow();
  });
});
