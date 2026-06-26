/**
 * customer `token_version` session-kill gate UNIT tests
 * (SECURITY-CRITICAL).
 *
 * Covers the equality gate in BOTH guards with a real {@link CustomerTokenService}
 * (so the `tv` claim is genuinely minted/verified) and a stubbed DatabaseService
 * that returns a row with a controllable `token_version`:
 *   - a token minted with tv=N is ACCEPTED when the row's token_version === N.
 *   - the MANDATORY guard REJECTS (401) when the row's token_version ≠ the token tv.
 *   - the OPTIONAL guard treats a stale-tv token as ANONYMOUS (returns true, does
 *     NOT attach req.customer, never throws).
 */
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { CustomerTokenService } from './customer-token.service';
import { CustomerAuthGuard } from './customer-auth.guard';
import { OptionalCustomerAuthGuard } from './optional-customer-auth.guard';
import type { AuthenticatedCustomer } from './authenticated-customer';

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

/**
 * A DatabaseService stub whose `db.select(...).from(...).where(...).limit(...)`
 * chain resolves to `[row]` (or `[]` when row is null). `row` carries the
 * `token_version` the guard will compare against the token's `tv`.
 */
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

function rowFor(tokenVersion: number): Record<string, unknown> {
  return {
    id: CUSTOMER.id,
    tenantId: CUSTOMER.tenantId,
    email: 'gate@x.test',
    name: 'Gate',
    isB2b: false,
    tokenVersion,
    deletedAt: null,
    anonymizedAt: null,
  };
}

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

describe('customer token_version session-kill gate (unit, SECURITY-CRITICAL)', () => {
  let tokens: CustomerTokenService;
  beforeEach(() => {
    tokens = makeTokens();
  });

  async function mint(tv: number): Promise<string> {
    return tokens.issueAccessToken({
      id: CUSTOMER.id,
      tenantId: CUSTOMER.tenantId,
      tokenVersion: tv,
    });
  }

  /** Sign a validly-signed, correct-purpose customer token with a MALFORMED `tv`
   *  claim (missing, or wrong type) — to pin that the gate fails CLOSED. A
   *  regression to the old `tv < tokenVersion` comparison would let a tv-less token
   *  pass (`undefined < N` is false → no reject); the strict `!==` must not. */
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

  describe('CustomerAuthGuard (mandatory)', () => {
    it('ACCEPTS when the token tv equals the row token_version (tv=N matches)', async () => {
      const token = await mint(3);
      const guard = new CustomerAuthGuard(tokens, makeDatabase(rowFor(3)) as never);
      const { ctx, req } = ctxWith(token);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.customer).toEqual({
        id: CUSTOMER.id,
        tenantId: CUSTOMER.tenantId,
        email: 'gate@x.test',
        name: 'Gate',
        isB2b: false,
      });
    });

    it('REJECTS (401) when the row token_version was bumped past the token tv', async () => {
      const token = await mint(0); // minted before the bump
      const guard = new CustomerAuthGuard(tokens, makeDatabase(rowFor(1)) as never);
      const { ctx, req } = ctxWith(token);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(req.customer).toBeUndefined();
    });

    it('REJECTS (401, fail-closed) a validly-signed token with a MISSING tv claim', async () => {
      const token = await mintRawTv(undefined); // no tv at all
      const guard = new CustomerAuthGuard(tokens, makeDatabase(rowFor(0)) as never);
      const { ctx, req } = ctxWith(token);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(req.customer).toBeUndefined();
    });

    it('REJECTS (401, fail-closed) a token whose tv claim is a string, not a number', async () => {
      const token = await mintRawTv('0'); // wrong type — "0" !== 0
      const guard = new CustomerAuthGuard(tokens, makeDatabase(rowFor(0)) as never);
      const { ctx, req } = ctxWith(token);
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(req.customer).toBeUndefined();
    });
  });

  describe('OptionalCustomerAuthGuard (non-rejecting)', () => {
    it('attaches req.customer when the token tv matches the row token_version', async () => {
      const token = await mint(2);
      const guard = new OptionalCustomerAuthGuard(tokens, makeDatabase(rowFor(2)) as never);
      const { ctx, req } = ctxWith(token);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.customer?.id).toBe(CUSTOMER.id);
    });

    it('treats a stale-tv token as ANONYMOUS (true, no req.customer, never throws)', async () => {
      const token = await mint(0); // minted before the bump
      const guard = new OptionalCustomerAuthGuard(tokens, makeDatabase(rowFor(1)) as never);
      const { ctx, req } = ctxWith(token);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.customer).toBeUndefined();
    });

    it('treats a MISSING-tv token as ANONYMOUS, not an error (fail-closed, never throws)', async () => {
      const token = await mintRawTv(undefined);
      const guard = new OptionalCustomerAuthGuard(tokens, makeDatabase(rowFor(0)) as never);
      const { ctx, req } = ctxWith(token);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.customer).toBeUndefined();
    });
  });
});
