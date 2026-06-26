/**
 * CustomerAuthGuard (SECURITY-CRITICAL.1).
 *
 * The customer-side mirror of the admin {@link JwtAuthGuard}. It is NOT global —
 * it is applied per-controller/route on the `/store/v1/customers/me/*` surface.
 * It NEVER opts a route out via `@Public()`; it is the positive gate. (The global
 * admin JwtAuthGuard already lets `/store/*` through when the store controller is
 * `@Public()`; THIS guard re-imposes customer auth where required, so a `@Public`
 * store controller cannot accidentally leave `/me/*` unauthenticated.)
 *
 * On each request the guard:
 *   1. Extracts `Authorization: Bearer <jwt>` and verifies it via
 *      {@link CustomerTokenService.verifyAccessToken} (alg-pinned H
 *      purpose=='customer'). An admin `purpose:'access'` token is REJECTED here.
 *   2. Loads the customer ROW `WHERE id = sub AND tenant_id = claim.tid`. A
 *      missing row (wrong tenant) is a 401.
 *   3. REJECTS a deleted (`deleted_at`) or anonymized (`anonymized_at`) customer —
 * an erased customer can never authenticate (.2: irreversible).
 *   4. Enforces the `token_version` session-kill gate: rejects (401) any access
 *      token whose `tv` claim ≠ the customer row's current `token_version`. Bumping
 *      a customer's `token_version` therefore invalidates every outstanding access
 *      token (a complementary lever to refresh-token family revocation).
 *   5. Sets `req.customer` from the DB ROW — tenantId is from the row, never the
 *      (attacker-influenceable) claim.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { DatabaseService } from '../../database/database.service';
import { CustomerTokenService } from './customer-token.service';
import type { AuthenticatedCustomer } from './authenticated-customer';
import { extractBearer, loadVerifiedCustomer } from './verified-customer-loader';

@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: CustomerTokenService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { customer?: AuthenticatedCustomer }>();
    const token = extractBearer(request);

    // POLICY (mandatory): no token → 401. Everything past this point — token verify,
    // row load, erased/anonymized + token_version checks, building the principal — is
    // the shared loadVerifiedCustomer() (see verified-customer-loader.ts). It THROWS
    // UnauthorizedException on any failure, which propagates here as a 401.
    if (!token) {
      throw new UnauthorizedException();
    }

    request.customer = await loadVerifiedCustomer(token, {
      tokens: this.tokens,
      database: this.database,
    });
    return true;
  }
}
