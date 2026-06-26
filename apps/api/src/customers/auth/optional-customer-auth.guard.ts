/**
 * OptionalCustomerAuthGuard.
 *
 * A non-rejecting sibling of {@link CustomerAuthGuard} for routes that accept
 * EITHER an anonymous caller (e.g. a guest cart authorised by its cart-token
 * cookie) OR an authenticated customer. When a valid `Authorization: Bearer`
 * customer token is present it attaches `req.customer` (DB-sourced principal,
 * exactly like the mandatory guard); when the token is absent, malformed, or
 * invalid it simply returns `true` WITHOUT attaching a principal — the route's
 * own logic then decides authorisation (e.g. the cart-token cookie path).
 *
 * Security note: this never *grants* access on its own. It only populates the
 * optional principal; downstream code (CartService.authorise) still enforces
 * ownership. An invalid token is treated as "no customer", never as an error,
 * so it cannot be used to probe token validity on these public store routes.
 * `tenantId` is taken from the DB ROW, never the JWT claim.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { DatabaseService } from '../../database/database.service';
import { CustomerTokenService } from './customer-token.service';
import type { AuthenticatedCustomer } from './authenticated-customer';
import { extractBearer, loadVerifiedCustomer } from './verified-customer-loader';

@Injectable()
export class OptionalCustomerAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: CustomerTokenService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { customer?: AuthenticatedCustomer }>();
    const token = extractBearer(request);
    if (!token) {
      return true; // anonymous — leave req.customer unset
    }

    // POLICY (non-rejecting): a token is present, so attempt the SHARED verify+load
    // (see verified-customer-loader.ts: token verify → row load → erased/anonymized +
    // token_version checks → principal). An AUTH failure (bad/expired/wrong-purpose
    // token, missing row, erased/anonymized customer, stale tv) surfaces as an
    // UnauthorizedException and is downgraded to anonymous — NEVER a 401 — so a bad
    // token cannot be used to probe token validity on these public store routes.
    // A genuine DB/infra error is NOT an UnauthorizedException and MUST propagate
    // (→ 500), exactly as the pre-refactor guard did (its DB query sat outside the
    // verify try/catch) — masking a DB outage as "anonymous" would be a regression.
    // Only a fully-valid token attaches req.customer.
    try {
      request.customer = await loadVerifiedCustomer(token, {
        tokens: this.tokens,
        database: this.database,
      });
    } catch (e) {
      if (e instanceof UnauthorizedException) {
        return true; // invalid token → treat as anonymous, do NOT reject
      }
      throw e; // DB / infra error → propagate (→ 500), never silently anonymous
    }
    return true;
  }
}
