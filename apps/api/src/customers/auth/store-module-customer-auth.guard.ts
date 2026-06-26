/**
 * StoreModuleCustomerAuthGuard (SECURITY-CRITICAL).
 *
 * The customer-auth seam into the module sandbox. Applied ONLY to the STORE module proxy mount
 * (`/store/v1/modules/...`), it makes a CORE-VERIFIED customer principal available to a module
 * while still allowing anonymous calls -- so customer-scoped reference modules (Wishlist / Notify /
 * Reviews / Recently-Viewed) can securely know the buyer, and public module endpoints keep working.
 *
 * It is NEITHER the mandatory {@link CustomerAuthGuard} (which 401s when no token is present) NOR
 * the non-rejecting {@link OptionalCustomerAuthGuard} (which silently treats a BAD token as
 * anonymous -- the right behaviour for the guest-cart path, where token-probing must be impossible).
 * The module mount needs a THIRD policy:
 *
 *   - NO `Authorization` header         -> proceed ANONYMOUS (no `req.customer`, no 401). A module
 *                                          endpoint that requires a customer enforces that itself.
 *   - VALID customer token              -> attach the DB-sourced principal to `req.customer`.
 *   - PRESENTED-but-BAD token           -> 401. A token that is malformed, expired, wrong-purpose
 *     (an admin token), tampered, belongs to an erased/missing customer, or carries a stale
 *     `token_version` is an ERROR, never silently downgraded to "anonymous". A caller who
 *     presents a credential is telling us who they are; a bad one must fail closed, not be ignored.
 *
 * GUEST IDENTITY (Decision 074):
 *
 * When no customer session is present, the guard also resolves (or mints) a GUEST identity:
 *
 *   - A `sov_guest` httpOnly cookie is verified (HMAC-SHA256, tenant-scoped) and the extracted
 *     guestId is set on `req.guestId`.
 *   - If no valid cookie is present, a new guest token is minted and the cookie is set on the
 *     response (same request, so subsequent module fetches in the same page-load carry it).
 *   - When a customer IS authenticated, `req.guestId` is NOT set (customer always wins; merge
 *     is the storefront's responsibility after login).
 *
 * The guestId is NEVER read from client input (body/query/headers). It is derived solely from
 * the signed, httpOnly cookie that the server minted. A guest cannot forge or predict another
 * guest's id.
 *
 * Verification REUSES {@link CustomerTokenService.verifyAccessToken} (alg-pinned HS256,
 * `purpose==='customer'`) and the SAME DB row checks as the mandatory guard -- no new token logic.
 * `tenantId` is taken from the DB ROW, never the JWT claim; the module never receives the raw
 * token (the proxy strips `authorization`/`cookie`) and only ever gets `{ id }`.
 */
import { CanActivate, ExecutionContext, Injectable, Optional } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DatabaseService } from '../../database/database.service';
import { StoreTenantService } from '../../catalog/store-tenant.service';
import { CustomerTokenService } from './customer-token.service';
import type { AuthenticatedCustomer } from './authenticated-customer';
import { extractBearer, loadVerifiedCustomer } from './verified-customer-loader';
import {
  GUEST_COOKIE_NAME,
  GUEST_COOKIE_MAX_AGE_MS,
  mintGuestToken,
  verifyGuestToken,
  resolveGuestCookieDomain,
} from './guest-token.service';

/** The shape augmented onto the Express request by this guard. */
export interface GuestAugmentedRequest extends Request {
  customer?: AuthenticatedCustomer;
  guestId?: string;
}

@Injectable()
export class StoreModuleCustomerAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: CustomerTokenService,
    private readonly database: DatabaseService,
    @Optional() private readonly storeTenant?: StoreTenantService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GuestAugmentedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const token = extractBearer(request);

    // POLICY (module seam): NO credential presented -> anonymous (leave req.customer unset;
    // the call proceeds). A credential WAS presented -> from here on anything wrong is a 401,
    // fail closed: the shared loadVerifiedCustomer() does the token verify -> row load ->
    // erased/anonymized + token_version checks -> principal, and THROWS UnauthorizedException
    // on any failure -- which propagates here as a 401 (NOT downgraded to anonymous). A caller
    // who presents a credential must fail closed, not be ignored.
    if (token) {
      request.customer = await loadVerifiedCustomer(token, {
        tokens: this.tokens,
        database: this.database,
      });
      // Customer authenticated: do NOT set guestId (customer always wins). The storefront is
      // responsible for calling the merge endpoint after login.
      return true;
    }

    // ANONYMOUS path: resolve or mint the guest identity.
    await this.resolveOrMintGuest(request, response);
    return true;
  }

  /**
   * Resolve the tenant, then verify the existing sov_guest cookie or mint a new one and set
   * it on the response. Sets `req.guestId` to the resolved UUID. Fail-soft: if the tenant
   * cannot be resolved or token minting fails, we leave `req.guestId` unset rather than
   * crashing the module request -- modules that require a guest identity return 401/empty
   * themselves.
   */
  private async resolveOrMintGuest(
    request: GuestAugmentedRequest,
    response: Response,
  ): Promise<void> {
    let tenantId: string;
    try {
      // StoreTenantService is optional in tests that only test the customer path.
      if (!this.storeTenant) return;
      tenantId = await this.storeTenant.getDefaultTenantId();
    } catch {
      return;
    }

    const rawCookie = (request.cookies as Record<string, string> | undefined)?.[GUEST_COOKIE_NAME];
    const existingGuestId = verifyGuestToken(rawCookie, tenantId);

    if (existingGuestId) {
      // Valid existing guest cookie -- reuse the identity.
      request.guestId = existingGuestId;
      return;
    }

    // No valid cookie: mint a new guest identity and set the cookie on the response.
    let newToken: string;
    try {
      newToken = mintGuestToken(tenantId);
    } catch {
      // Signing secret unavailable -- fail soft (no guestId set). The module will see anonymous.
      return;
    }

    // Extract the guestId from the freshly-minted token to set on the request for this response.
    const newGuestId = verifyGuestToken(newToken, tenantId);
    if (!newGuestId) return; // Should never happen, but be defensive.

    request.guestId = newGuestId;

    const domain = resolveGuestCookieDomain();
    response.cookie(GUEST_COOKIE_NAME, newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: GUEST_COOKIE_MAX_AGE_MS,
      path: '/',
      ...(domain ? { domain } : {}),
    });
  }
}
