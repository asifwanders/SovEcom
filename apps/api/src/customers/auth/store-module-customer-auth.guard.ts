/**
 * StoreModuleCustomerAuthGuard (SECURITY-CRITICAL).
 *
 * The customer-auth seam into the module sandbox. Applied ONLY to the STORE module proxy mount
 * (`/store/v1/modules/...`), it makes a CORE-VERIFIED customer principal available to a module
 * while still allowing anonymous calls — so customer-scoped reference modules (Wishlist / Notify /
 * Reviews / Recently-Viewed) can securely know the buyer, and public module endpoints keep working.
 *
 * It is NEITHER the mandatory {@link CustomerAuthGuard} (which 401s when no token is present) NOR
 * the non-rejecting {@link OptionalCustomerAuthGuard} (which silently treats a BAD token as
 * anonymous — the right behaviour for the guest-cart path, where token-probing must be impossible).
 * The module mount needs a THIRD policy:
 *
 *   - NO `Authorization` header         → proceed ANONYMOUS (no `req.customer`, no 401). A module
 *                                          endpoint that requires a customer enforces that itself.
 *   - VALID customer token              → attach the DB-sourced principal to `req.customer`.
 *   - PRESENTED-but-BAD token           → 401. A token that is malformed, expired, wrong-purpose
 *     (an admin token), tampered, belongs to an erased/missing customer, or carries a stale
 *     `token_version` is an ERROR, never silently downgraded to "anonymous". A caller who
 *     presents a credential is telling us who they are; a bad one must fail closed, not be ignored.
 *
 * Verification REUSES {@link CustomerTokenService.verifyAccessToken} (alg-pinned HS256,
 * `purpose==='customer'`) and the SAME DB row checks as the mandatory guard — no new token logic.
 * `tenantId` is taken from the DB ROW, never the JWT claim; the module never receives the raw
 * token (the proxy strips `authorization`/`cookie`) and only ever gets `{ id }`.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { DatabaseService } from '../../database/database.service';
import { CustomerTokenService } from './customer-token.service';
import type { AuthenticatedCustomer } from './authenticated-customer';
import { extractBearer, loadVerifiedCustomer } from './verified-customer-loader';

@Injectable()
export class StoreModuleCustomerAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: CustomerTokenService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { customer?: AuthenticatedCustomer }>();
    const token = extractBearer(request);

    // POLICY (module seam): NO credential presented → anonymous (leave req.customer unset;
    // the call proceeds). A credential WAS presented → from here on anything wrong is a 401,
    // fail closed: the shared loadVerifiedCustomer() does the token verify → row load →
    // erased/anonymized + token_version checks → principal, and THROWS UnauthorizedException
    // on any failure — which propagates here as a 401 (NOT downgraded to anonymous). A caller
    // who presents a credential must fail closed, not be ignored.
    if (!token) {
      return true;
    }

    request.customer = await loadVerifiedCustomer(token, {
      tokens: this.tokens,
      database: this.database,
    });
    return true;
  }
}
