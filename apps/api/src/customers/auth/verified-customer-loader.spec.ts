/**
 * verified-customer-loader UNIT tests (SECURITY-CRITICAL).
 *
 * Direct, focused tests for the ONE shared unit the three customer-auth guards now
 * delegate to ({@link loadVerifiedCustomer} + {@link extractBearer}). The three guard
 * specs still prove the END-TO-END policy of each guard is UNCHANGED; this spec pins
 * the shared helper's contract directly:
 *
 *   - valid token + matching row          → returns the DB-sourced principal.
 *   - invalid / expired / wrong-purpose   → THROWS UnauthorizedException.
 *   - missing row (wrong tenant / id)     → THROWS.
 *   - soft-deleted (deletedAt) alone      → THROWS.
 *   - anonymized (anonymizedAt) alone     → THROWS.
 *   - stale / missing / wrong-type tv     → THROWS (strict !==, fail closed).
 *
 * It uses a REAL {@link CustomerTokenService} (so signature / purpose / tv are genuinely
 * minted + verified) and a stubbed DatabaseService returning a controllable row — the
 * same fixtures the guard specs use, so the helper is tested under identical conditions.
 */
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { CustomerTokenService } from './customer-token.service';
import { loadVerifiedCustomer, extractBearer } from './verified-customer-loader';
import { OptionalCustomerAuthGuard } from './optional-customer-auth.guard';
import type { AuthenticatedCustomer } from './authenticated-customer';
import type { Request } from 'express';

const SECRET = 'unit-test-secret-unit-test-secret-unit-test-secret-32+';

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

/**
 * A DatabaseService stub whose terminal `.limit()` REJECTS with a non-Unauthorized
 * error — modelling a real DB/infra fault (connection drop, timeout, query failure).
 * Used to pin that such an error is NOT converted to an auth failure: the loader lets
 * it propagate natively, and the optional guard re-throws it (→ 500) instead of
 * silently downgrading to anonymous.
 */
class DbDownError extends Error {}
function makeFailingDatabase(): { db: unknown } {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.reject(new DbDownError('connection terminated')),
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
    email: 'loader@x.test',
    name: 'Loader',
    isB2b: false,
    tokenVersion,
    deletedAt: over.deletedAt ?? null,
    anonymizedAt: over.anonymizedAt ?? null,
  };
}

describe('loadVerifiedCustomer (unit, SECURITY-CRITICAL)', () => {
  let tokens: CustomerTokenService;
  beforeEach(() => {
    tokens = makeTokens();
  });

  const mint = (tv: number): Promise<string> =>
    tokens.issueAccessToken({ id: CUSTOMER.id, tenantId: CUSTOMER.tenantId, tokenVersion: tv });

  /** A validly-signed, correct-purpose token with a raw / overridable `tv` claim. */
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

  it('VALID token + matching row → returns the DB-sourced principal (tenantId from the ROW)', async () => {
    const token = await mint(4);
    const principal = await loadVerifiedCustomer(token, {
      tokens,
      database: makeDatabase(rowFor(4)) as never,
    });
    expect(principal).toEqual({
      id: CUSTOMER.id,
      tenantId: CUSTOMER.tenantId,
      email: 'loader@x.test',
      name: 'Loader',
      isB2b: false,
    });
  });

  it('MALFORMED token (garbage) → throws UnauthorizedException', async () => {
    await expect(
      loadVerifiedCustomer('not-a-jwt', { tokens, database: makeDatabase(rowFor(0)) as never }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('EXPIRED token → throws UnauthorizedException', async () => {
    const raw = new JwtService();
    const expired = await raw.signAsync(
      { sub: CUSTOMER.id, tid: CUSTOMER.tenantId, tv: 0, purpose: 'customer' },
      { algorithm: 'HS256', expiresIn: '-1s', secret: SECRET },
    );
    await expect(
      loadVerifiedCustomer(expired, { tokens, database: makeDatabase(rowFor(0)) as never }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('WRONG-PURPOSE token (admin purpose:access, same secret) → throws', async () => {
    const raw = new JwtService();
    const adminToken = await raw.signAsync(
      { sub: CUSTOMER.id, tid: CUSTOMER.tenantId, tv: 0, purpose: 'access' },
      { algorithm: 'HS256', expiresIn: '15m', secret: SECRET },
    );
    await expect(
      loadVerifiedCustomer(adminToken, { tokens, database: makeDatabase(rowFor(0)) as never }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('MISSING row (wrong tenant / unknown id) → throws', async () => {
    const token = await mint(0);
    await expect(
      loadVerifiedCustomer(token, { tokens, database: makeDatabase(null) as never }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('SOFT-DELETED customer (deletedAt set, anonymizedAt null) → throws', async () => {
    const token = await mint(0);
    await expect(
      loadVerifiedCustomer(token, {
        tokens,
        database: makeDatabase(rowFor(0, { deletedAt: new Date() })) as never,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('ANONYMIZED customer (anonymizedAt set, deletedAt null) → throws (OR branch alone)', async () => {
    const token = await mint(0);
    await expect(
      loadVerifiedCustomer(token, {
        tokens,
        database: makeDatabase(rowFor(0, { anonymizedAt: new Date() })) as never,
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('STALE token_version (row bumped past token tv) → throws', async () => {
    const token = await mint(0);
    await expect(
      loadVerifiedCustomer(token, { tokens, database: makeDatabase(rowFor(1)) as never }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('MISSING tv claim → throws (fail-closed, strict !==)', async () => {
    const token = await mintRawTv(undefined);
    await expect(
      loadVerifiedCustomer(token, { tokens, database: makeDatabase(rowFor(0)) as never }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('WRONG-TYPE tv claim (string "0" !== number 0) → throws (fail-closed)', async () => {
    const token = await mintRawTv('0');
    await expect(
      loadVerifiedCustomer(token, { tokens, database: makeDatabase(rowFor(0)) as never }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('DB/infra error (valid token) → propagates NATIVELY, NOT converted to UnauthorizedException', async () => {
    // Only verifyAccessToken is wrapped in the loader's try/catch; the DB query is not.
    // A genuine DB fault must surface as itself so callers can distinguish it from an
    // auth failure (the optional guard re-throws it; the others 500 too).
    const token = await mint(0);
    await expect(
      loadVerifiedCustomer(token, { tokens, database: makeFailingDatabase() as never }),
    ).rejects.toBeInstanceOf(DbDownError);
  });
});

/**
 * The OptionalCustomerAuthGuard's error policy AT THE GUARD LEVEL: an AUTH failure
 * (UnauthorizedException from the shared loader) → anonymous (true, no req.customer);
 * a DB/infra error (anything NOT UnauthorizedException) → RE-THROWN, never masked as
 * anonymous. This preserves the pre-refactor behaviour, where the DB query sat OUTSIDE
 * the verify try/catch and a DB error propagated → 500 on these public routes.
 */
describe('OptionalCustomerAuthGuard error policy (DB error vs auth failure)', () => {
  let tokens: CustomerTokenService;
  beforeEach(() => {
    tokens = makeTokens();
  });

  const mint = (tv: number): Promise<string> =>
    tokens.issueAccessToken({ id: CUSTOMER.id, tenantId: CUSTOMER.tenantId, tokenVersion: tv });

  function ctxWith(token: string | null): {
    ctx: ExecutionContext;
    req: { headers: Record<string, string>; customer?: AuthenticatedCustomer };
  } {
    const req: { headers: Record<string, string>; customer?: AuthenticatedCustomer } = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { ctx, req };
  }

  it('DB/infra error (valid token) → RE-THROWS the error (NOT anonymous, NOT swallowed)', async () => {
    const token = await mint(0);
    const guard = new OptionalCustomerAuthGuard(tokens, makeFailingDatabase() as never);
    const { ctx, req } = ctxWith(token);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(DbDownError);
    expect(req.customer).toBeUndefined();
  });

  it('AUTH failure: stale token_version (auth reason) → anonymous (true, no req.customer)', async () => {
    const token = await mint(0); // minted before the bump
    const guard = new OptionalCustomerAuthGuard(tokens, makeDatabase(rowFor(1)) as never);
    const { ctx, req } = ctxWith(token);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.customer).toBeUndefined();
  });

  it('AUTH failure: erased customer (auth reason) → anonymous (true, no req.customer)', async () => {
    const token = await mint(0);
    const guard = new OptionalCustomerAuthGuard(
      tokens,
      makeDatabase(rowFor(0, { deletedAt: new Date() })) as never,
    );
    const { ctx, req } = ctxWith(token);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.customer).toBeUndefined();
  });

  it('AUTH failure: malformed token (auth reason) → anonymous (true, no req.customer)', async () => {
    const guard = new OptionalCustomerAuthGuard(tokens, makeDatabase(rowFor(0)) as never);
    const { ctx, req } = ctxWith('not-a-jwt');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.customer).toBeUndefined();
  });
});

describe('extractBearer (unit) — preserves the EXACT current header handling', () => {
  const req = (authorization?: string): Request =>
    ({ headers: authorization === undefined ? {} : { authorization } }) as unknown as Request;

  it('returns null when there is no Authorization header', () => {
    expect(extractBearer(req(undefined))).toBeNull();
  });

  it('returns the token for a well-formed "Bearer <token>" header', () => {
    expect(extractBearer(req('Bearer abc.def.ghi'))).toBe('abc.def.ghi');
  });

  it('returns null for a non-Bearer scheme (case-sensitive, e.g. "bearer")', () => {
    expect(extractBearer(req('bearer abc'))).toBeNull();
  });

  it('returns null for a missing token value ("Bearer" alone)', () => {
    expect(extractBearer(req('Bearer'))).toBeNull();
  });
});
