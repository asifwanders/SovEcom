/**
 * PermissionsGuard (SECURITY-CRITICAL).
 *
 * Second GLOBAL guard, running AFTER the (also global) JwtAuthGuard. FAIL-CLOSED:
 *   1. `@Public()` -> allow (JwtAuthGuard already let it through; req.user unset).
 *   2. No `req.user` on a non-public route -> 403 (covers any guard mis-ordering;
 *      never opens).
 *   3. `@AnyAuthenticated()` -> allow any authenticated principal.
 *   4. `@RequirePermission(p)` -> allow iff the principal's ROLE holds `p`.
 *   5. A protected route that declares NEITHER marker -> 403 (a forgotten
 *      decorator fails safe; it is never silently open).
 *
 * Role comes from `req.user.role`, which JwtAuthGuard re-read from the DB row —
 * never from the raw JWT claim. Every denial is audited. The check runs
 * before the handler, hence before any tenant-scoped query (authz precedes data).
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuditService } from '../../audit/audit.service';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { PermissionsService } from '../services/permissions.service';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { ANY_AUTHENTICATED_KEY } from '../decorators/any-authenticated.decorator';
import type { Permission } from '../permissions.constants';

@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    // Resolve ALL markers up front (handler overrides class for each).
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets);
    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      targets,
    );
    const anyAuth = this.reflector.getAllAndOverride<boolean>(ANY_AUTHENTICATED_KEY, targets);

    // Misconfiguration: `@Public` (no auth at all) must never be combined with an
    // authorization marker. Treat as a hard error and DENY (never silently open).
    if (isPublic && (required || anyAuth)) {
      this.logger.error(
        '@Public route also declares @RequirePermission/@AnyAuthenticated — denying (misconfiguration)',
      );
      throw new ForbiddenException();
    }

    // Public routes opt out of auth entirely — never block them here.
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;

    // Fail-closed: a non-public route with no authenticated principal is denied
    // (also guards against PermissionsGuard running before JwtAuthGuard).
    if (!user) {
      throw new ForbiddenException();
    }

    // STRICT-MARKER-WINS: a declared permission is ALWAYS enforced, even if
    // `@AnyAuthenticated` is also present (e.g. inherited from the class). This
    // prevents a class-level any-authenticated from silently opening a
    // permissioned handler.
    if (required) {
      if (this.permissions.hasPermission(user.role, required)) {
        return true;
      }
      await this.auditDenial(user, request, required);
      throw new ForbiddenException();
    }

    // No permission declared: an explicit `@AnyAuthenticated` opens the route to
    // any authenticated principal.
    if (anyAuth) {
      return true;
    }

    // Neither marker on a protected route — fail closed (forgotten decorator).
    await this.auditDenial(user, request, null);
    throw new ForbiddenException();
  }

  /**
   * Write an `authz.permission.denied` audit row. MUST NOT throw — a
   * failure here must never turn a 403 into a 500. (AuditService already swallows
   * its own DB errors; this also covers the request-property reads.)
   */
  private async auditDenial(
    user: AuthenticatedUser,
    request: Request,
    required: Permission | null,
  ): Promise<void> {
    try {
      const route = (request.route as { path?: string } | undefined)?.path ?? request.path;
      await this.audit.record({
        tenantId: user.tenantId,
        actorType: 'user',
        actorId: user.id,
        action: 'authz.permission.denied',
        // `resource_id` is a UUID column — the route is NOT a UUID, so it goes in
        // `changes`, never resourceId.
        resourceType: 'route',
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        changes: {
          method: request.method,
          route,
          requiredPermission: required,
          role: user.role,
        },
      });
    } catch (err) {
      this.logger.error(
        `failed to audit authorization denial: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
}
