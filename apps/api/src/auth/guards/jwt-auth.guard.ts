/**
 * JwtAuthGuard (SECURITY-CRITICAL).
 *
 * Registered GLOBALLY via `APP_GUARD` and FAIL-CLOSED: every route requires a
 * valid access token unless it carries the `@Public()` Symbol marker.
 *
 * On each request the guard:
 *   1. Honours `@Public()` (Reflector lookup on the unique Symbol key) — the ONLY
 *      opt-out. A missing/garbage token on a non-public route is a 401.
 *   2. Extracts the `Authorization: Bearer <jwt>` token and verifies it via
 *      {@link TokenService.verifyAccessToken} (alg-pinned HS256, purpose==access).
 *   3. Loads the user ROW `WHERE id = sub AND tenant_id = claim.tid`. A row that
 *      does not exist (wrong tenant / deleted user) is a 401.
 *   4. Rejects if `claim.tv < users.token_version` (a logout-all / password reset
 *      / lock bumped the version, killing this still-unexpired token).
 *   5. Sets `req.user` from the DB ROW — `tenantId` and `role` come from the row,
 *      NEVER from the (attacker-influenceable) claim downstream.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { users } from '../../database/schema/users';
import { TokenService } from '../services/token.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedUser } from '../authenticated-user';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // (1) Public opt-out via the unique Symbol marker (handler OR controller).
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const token = JwtAuthGuard.extractBearer(request);
    if (!token) {
      throw new UnauthorizedException();
    }

    // (2) Verify the access token. Any failure (bad sig, alg confusion, expiry,
    //     wrong purpose) throws and collapses to a 401 — fail closed.
    let claims;
    try {
      claims = await this.tokens.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException();
    }

    // (3) Load the user ROW scoped to the claimed tenant. The composite predicate
    //     means a token whose `tid` was altered resolves to no row -> 401.
    const [row] = await this.database.db
      .select({
        id: users.id,
        tenantId: users.tenantId,
        email: users.email,
        name: users.name,
        role: users.role,
        totpEnabled: users.totpEnabled,
        tokenVersion: users.tokenVersion,
      })
      .from(users)
      .where(and(eq(users.id, claims.sub), eq(users.tenantId, claims.tid)))
      .limit(1);

    if (!row) {
      throw new UnauthorizedException();
    }

    // (4) token_version gate: a bump (logout-all / reset / lock) invalidates every
    //     still-unexpired access token for this user.
    if (claims.tv < row.tokenVersion) {
      throw new UnauthorizedException();
    }

    // (5) Attach the DB-sourced principal. tenantId/role are from the ROW.
    request.user = {
      id: row.id,
      tenantId: row.tenantId,
      email: row.email,
      name: row.name,
      role: row.role,
      totpEnabled: row.totpEnabled,
    };
    return true;
  }

  /** Pull the bearer token out of the Authorization header, or null. */
  private static extractBearer(request: Request): string | null {
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
}
