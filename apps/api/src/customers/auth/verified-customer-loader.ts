/**
 * The ONE shared verify+load+check unit for the three customer-auth guards
 * (SECURITY-CRITICAL).
 *
 * {@link CustomerAuthGuard} (mandatory), {@link OptionalCustomerAuthGuard}
 * (non-rejecting) and {@link StoreModuleCustomerAuthGuard} (module-seam) all need
 * the IDENTICAL "is this bearer token a live customer?" computation; only their
 * POLICY around the no-token and bad-token edges differs. That shared computation
 * used to be copy-pasted (~30 lines each, with "keep in sync" comments). It now
 * lives here ONCE, so a future auth check (e.g. a `locked_at` lockout) is added in
 * ONE place instead of three.
 *
 * {@link loadVerifiedCustomer} does EXACTLY what the three shared:
 *   1. Verify the CUSTOMER access token via
 *      {@link CustomerTokenService.verifyAccessToken} (alg-pinned HS256,
 *      purpose=='customer'). Any failure (bad sig, alg confusion, expiry, wrong
 *      purpose — e.g. an admin `access` token) → throw.
 *   2. Load the customer ROW `WHERE id = sub AND tenant_id = claim.tid`. A missing
 *      row (wrong tenant / unknown id) → throw.
 *   3. Reject a deleted (`deleted_at`) or anonymized (`anonymized_at`) customer —
 *      an erased customer can never authenticate (irreversible).
 *   4. Enforce the `token_version` session-kill gate (strict `!==`, fail closed):
 *      reject any token whose `tv` claim ≠ the row's current `token_version`.
 *   5. Return the DB-sourced {@link AuthenticatedCustomer}. `tenantId` is from the
 *      ROW, never the (attacker-influenceable) claim.
 *
 * It THROWS {@link UnauthorizedException} on ANY failure — the guards translate that
 * into their respective policy (mandatory & module-seam: propagate → 401; optional:
 * catch → anonymous). No check or error here may change without changing all three
 * guards' behaviour, so it is covered both directly and end-to-end by each guard's spec.
 */
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { customers } from '../../database/schema/customers';
import { CustomerTokenService } from './customer-token.service';
import type { CustomerTokenClaims } from './customer-token.service';
import type { AuthenticatedCustomer } from './authenticated-customer';

/** The collaborators the loader needs — the same two each guard already injects. */
export interface VerifiedCustomerDeps {
  tokens: CustomerTokenService;
  database: DatabaseService;
}

/**
 * Verify a customer bearer token and load its live principal, or THROW
 * {@link UnauthorizedException} on any failure (invalid/expired/wrong-purpose token,
 * missing row, erased/anonymized customer, or stale `token_version`). See the file
 * header for the exact, behaviour-preserving sequence.
 */
export async function loadVerifiedCustomer(
  token: string,
  deps: VerifiedCustomerDeps,
): Promise<AuthenticatedCustomer> {
  // (1) Verify the CUSTOMER access token. Any failure (bad sig, alg confusion,
  //     expiry, wrong purpose — e.g. an admin `access` token) → 401, fail closed.
  //     ONLY this verify step is converted to UnauthorizedException; the DB query
  //     below is INTENTIONALLY outside the try so a genuine DB/infra error
  //     propagates NATIVELY (unconverted) — the optional guard relies on that to
  //     distinguish an auth failure (→ anonymous) from a DB outage (→ 500).
  let claims: CustomerTokenClaims;
  try {
    claims = await deps.tokens.verifyAccessToken(token);
  } catch {
    throw new UnauthorizedException();
  }

  // (2) Load the customer ROW scoped to the claimed tenant. An altered `tid`
  //     resolves to no row → 401.
  const [row] = await deps.database.db
    .select({
      id: customers.id,
      tenantId: customers.tenantId,
      email: customers.email,
      name: customers.name,
      isB2b: customers.isB2b,
      tokenVersion: customers.tokenVersion,
      deletedAt: customers.deletedAt,
      anonymizedAt: customers.anonymizedAt,
    })
    .from(customers)
    .where(and(eq(customers.id, claims.sub), eq(customers.tenantId, claims.tid)))
    .limit(1);

  if (!row) {
    throw new UnauthorizedException();
  }

  // (3) An erased / soft-deleted customer can never authenticate (irreversible).
  if (row.deletedAt !== null || row.anonymizedAt !== null) {
    throw new UnauthorizedException();
  }

  // (4) Session-kill gate: the token's `tv` must EQUAL the row's current
  //     token_version. Strict `!==` so a missing / wrong-type tv claim fails closed.
  if (claims.tv !== row.tokenVersion) {
    throw new UnauthorizedException();
  }

  // (5) The DB-sourced principal. tenantId is from the ROW, never the claim.
  return {
    id: row.id,
    tenantId: row.tenantId,
    email: row.email,
    name: row.name,
    isB2b: row.isB2b,
  };
}

/**
 * Pull the bearer token out of the `Authorization` header, or null. Behaviour is
 * IDENTICAL to the per-guard copies it replaces: a case-sensitive `Bearer` scheme,
 * single-space split, non-empty value required. Do NOT "fix" the whitespace/case
 * handling here — the three guards depend on this EXACT behaviour.
 */
export function extractBearer(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) {
    return null;
  }
  return value;
}
