/**
 * StoreModuleCustomerAuthGuard UNIT tests (SECURITY-CRITICAL).
 *
 * The customer-auth seam into the module sandbox has a THIRD policy distinct from the two existing
 * guards: anonymous IS allowed (no 401 when no token), but a PRESENTED-but-bad token is a 401
 * (never silently downgraded to anonymous). These tests use a real {@link CustomerTokenService}
 * (so `tv`/`purpose`/signature are genuinely minted+verified) and a stubbed DatabaseService.
 */
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { CustomerTokenService } from './customer-token.service';
import { StoreModuleCustomerAuthGuard } from './store-module-customer-auth.guard';
import type { AuthenticatedCustomer } from './authenticated-customer';

const SECRET = 'unit-test-secret-unit-test-secret-unit-test-secret-32+';
const ADMIN_SECRET = SECRET; // same JWT_SECRET — the purpose claim is the kind tag.

const CUSTOMER = {
  id: '00000000-0000-7000-8000-000000000001',
  tenantId: '00000000-0000-7000-8000-0000000000aa',
};

function makeTokens(): CustomerTokenService {
  const config = {
    get: (key: string): string | undefined => (key === 'JWT_SECRET' ? SECRET : undefined),
  };
  return new CustomerTokenService(config as never);
}

function makeDatabase(row: Record<string, unknown> | null): { db: unknown } {
  const result = row ? [row] : [];
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(result),
  };
  return { db: chain };
}

function rowFor(
  tokenVersion: number,
  over: Partial<Record<'deletedAt' | 'anonymizedAt', Date>> = {},
): Record<string, unknown> {
  return {
    id: CUSTOMER.id,
    tenantId: CUSTOMER.tenantId,
    email: 'seam@x.test',
    name: 'Seam',
    isB2b: false,
    tokenVersion,
    deletedAt: over.deletedAt ?? null,
    anonymizedAt: over.anonymizedAt ?? null,
  };
}

function ctxWith(token: string | null): {
  ctx: ExecutionContext;
  req: { headers: Record<string, string>; customer?: AuthenticatedCustomer };
} {
  const req: { headers: Record<string, string>; customer?: AuthenticatedCustomer } = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  // Minimal response stub -- the guard only calls res.cookie() on the anonymous guest path.
  const res = { cookie: () => undefined };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

describe('StoreModuleCustomerAuthGuard (unit, SECURITY-CRITICAL)', () => {
  let tokens: CustomerTokenService;
  beforeEach(() => {
    tokens = makeTokens();
  });

  const mint = (tv: number): Promise<string> =>
    tokens.issueAccessToken({ id: CUSTOMER.id, tenantId: CUSTOMER.tenantId, tokenVersion: tv });

  /** A validly-signed, correct-purpose token with a raw/overridable `tv` claim. */
  function mintRawTv(tv: unknown): Promise<string> {
    const raw = new JwtService();
    const payload: Record<string, unknown> = {
      sub: CUSTOMER.id,
      tid: CUSTOMER.tenantId,
      purpose: 'customer',
    };
    if (tv !== undefined) payload.tv = tv;
    return raw.signAsync(payload, { algorithm: 'HS256', expiresIn: '15m', secret: SECRET });
  }

  it('NO token → proceeds ANONYMOUS (true, no req.customer, no 401)', async () => {
    const guard = new StoreModuleCustomerAuthGuard(tokens, makeDatabase(rowFor(0)) as never);
    const { ctx, req } = ctxWith(null);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.customer).toBeUndefined();
  });

  it('VALID token → attaches the DB-sourced principal (tenantId from the ROW)', async () => {
    const token = await mint(4);
    const guard = new StoreModuleCustomerAuthGuard(tokens, makeDatabase(rowFor(4)) as never);
    const { ctx, req } = ctxWith(token);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.customer).toEqual({
      id: CUSTOMER.id,
      tenantId: CUSTOMER.tenantId,
      email: 'seam@x.test',
      name: 'Seam',
      isB2b: false,
    });
  });

  it('MALFORMED token (garbage) → 401, not anonymous', async () => {
    const guard = new StoreModuleCustomerAuthGuard(tokens, makeDatabase(rowFor(0)) as never);
    const { ctx, req } = ctxWith('not-a-jwt');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(req.customer).toBeUndefined();
  });

  it('EXPIRED token → 401', async () => {
    const raw = new JwtService();
    const expired = await raw.signAsync(
      { sub: CUSTOMER.id, tid: CUSTOMER.tenantId, tv: 0, purpose: 'customer' },
      { algorithm: 'HS256', expiresIn: '-1s', secret: SECRET },
    );
    const guard = new StoreModuleCustomerAuthGuard(tokens, makeDatabase(rowFor(0)) as never);
    const { ctx } = ctxWith(expired);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('WRONG-PURPOSE token (admin purpose:access, same secret) → 401', async () => {
    const raw = new JwtService();
    const adminToken = await raw.signAsync(
      { sub: CUSTOMER.id, tid: CUSTOMER.tenantId, tv: 0, purpose: 'access' },
      { algorithm: 'HS256', expiresIn: '15m', secret: ADMIN_SECRET },
    );
    const guard = new StoreModuleCustomerAuthGuard(tokens, makeDatabase(rowFor(0)) as never);
    const { ctx, req } = ctxWith(adminToken);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(req.customer).toBeUndefined();
  });

  it('STALE token_version (session-killed) → 401 (NOT downgraded to anonymous)', async () => {
    const token = await mint(0); // minted before the bump
    const guard = new StoreModuleCustomerAuthGuard(tokens, makeDatabase(rowFor(1)) as never);
    const { ctx, req } = ctxWith(token);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(req.customer).toBeUndefined();
  });

  it('MISSING tv claim → 401 (fail-closed, strict !==)', async () => {
    const token = await mintRawTv(undefined);
    const guard = new StoreModuleCustomerAuthGuard(tokens, makeDatabase(rowFor(0)) as never);
    const { ctx } = ctxWith(token);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('customer row MISSING (wrong tenant / unknown id) → 401', async () => {
    const token = await mint(0);
    const guard = new StoreModuleCustomerAuthGuard(tokens, makeDatabase(null) as never);
    const { ctx } = ctxWith(token);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('SOFT-DELETED customer (deletedAt set) → 401', async () => {
    const token = await mint(0);
    const guard = new StoreModuleCustomerAuthGuard(
      tokens,
      makeDatabase(rowFor(0, { deletedAt: new Date() })) as never,
    );
    const { ctx } = ctxWith(token);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('ANONYMIZED customer (anonymizedAt set, deletedAt null) → 401 — covers the OR branch alone', async () => {
    // Exhaustively cover the `deletedAt !== null || anonymizedAt !== null` gate: an RGPD-erased
    // (anonymized) customer whose deletedAt is still null must ALSO fail closed.
    const token = await mint(0);
    const guard = new StoreModuleCustomerAuthGuard(
      tokens,
      makeDatabase(rowFor(0, { anonymizedAt: new Date() })) as never,
    );
    const { ctx, req } = ctxWith(token);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(req.customer).toBeUndefined();
  });
});
