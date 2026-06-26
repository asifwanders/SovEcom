/**
 * AuditInterceptor.
 *
 * A global APP_INTERCEPTOR that fires AFTER a successful (2xx) response
 * on any route decorated with `@Audit(action)`. It writes ONE audit_log row:
 *
 *   actorType  = 'user'
 *   actorId    = req.user.id
 *   tenantId   = req.user.tenantId  (DB-sourced — never a client claim)
 *   action     = value from @Audit(action) metadata
 *   resourceType / resourceId derived from the route path + params + response body
 *   changes    = redact(request body merged with query params)
 *   ip / userAgent from req
 *
 * The interceptor ONLY fires when `AUDIT_ACTION_KEY` metadata is present on the
 * handler. Routes without the decorator are untouched — this is not a blanket
 * logger. Routes that already self-audit in their service MUST NOT carry @Audit
 * (the route-coverage invariant test enforces this).
 *
 * Error policy: audit writes must NEVER propagate into the response path.
 * AuditService.record already swallows DB errors; this interceptor additionally
 * wraps the write in a try/catch so a broken AuditService injection never kills
 * a legitimate request.
 */
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, concatMap } from 'rxjs';
import { AuditService } from './audit.service';
import { AUDIT_ACTION_KEY } from './decorators/audit.decorator';
import { redact } from '../common/redaction.util';
import type { AuthenticatedUser } from '../auth/authenticated-user';

/**
 * Canonical UUID matcher (any RFC-4122 version, incl. v4 and the v7 used here).
 * The old `/^[0-9a-f-]{36}$/i` matched garbage like `------------------------------------`;
 * this validates the version nibble and variant bits properly (#8).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(val: unknown): val is string {
  return typeof val === 'string' && UUID_RE.test(val);
}

/**
 * Derive `resourceType` and `resourceId` from the route path, params, and the
 * handler's RESPONSE body.
 *
 *   resourceType: first path segment after `/admin/v1/` (e.g. `images`).
 *   resourceId  : the last UUID route param (e.g. `:id` on a DELETE), OR — when
 *                 the route has no id param (e.g. POST /admin/v1/images) — the
 *                 `id` of the created resource taken from the response body (#4),
 *                 so an upload row records WHICH image was created.
 */
function deriveResource(
  req: Request,
  responseBody: unknown,
): { resourceType: string; resourceId: string | undefined } {
  // req.route.path looks like /admin/v1/images/:id
  const routePath: string = (req.route as { path?: string } | undefined)?.path ?? req.path;

  // Extract the first segment after /admin/v1/ (strip leading slash)
  const parts = routePath.replace(/^\/+/, '').split('/');
  // parts[0] = 'admin', parts[1] = 'v1', parts[2] = resourceType
  const resourceType = parts[2] ?? 'unknown';

  // Prefer the last UUID route param (handles DELETE /…/:id, /…/:imageId).
  const params = req.params as Record<string, string | undefined>;
  let resourceId: string | undefined;
  for (const val of Object.values(params)) {
    if (isUuid(val)) {
      resourceId = val;
    }
  }

  // Fall back to the created resource's id from the response body (#4) — this is
  // how a POST with no id param (e.g. an image upload) records its new row's id.
  if (!resourceId && responseBody && typeof responseBody === 'object') {
    const bodyId = (responseBody as { id?: unknown }).id;
    if (isUuid(bodyId)) {
      resourceId = bodyId;
    }
  }

  return { resourceType, resourceId };
}

/**
 * Build the `changes` payload for an audited route: the request body MERGED with
 * the request query params (#12) so route-level inputs that arrive as query
 * params (e.g. `alt_text` on an image upload) are captured too, not just the
 * JSON body. A redacted copy is taken here as defence-in-depth; AuditService
 * also redacts on write.
 */
function buildChanges(req: Request): Record<string, unknown> | undefined {
  const body =
    req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const query =
    req.query && typeof req.query === 'object' ? (req.query as Record<string, unknown>) : {};

  const merged: Record<string, unknown> = { ...body };
  if (Object.keys(query).length > 0) {
    merged.query = query;
  }

  if (Object.keys(merged).length === 0) {
    return undefined;
  }
  return redact(merged) as Record<string, unknown>;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Only fire for routes carrying @Audit metadata.
    const action = this.reflector.getAllAndOverride<string | undefined>(AUDIT_ACTION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!action) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();

    // concatMap (NOT tap) so the audit write is AWAITED as part of the response
    // stream — the response completes only after the row is persisted, instead of
    // racing it fire-and-forget (#5). The write still swallows its own errors so
    // the handler's result is never lost to an audit failure.
    return next.handle().pipe(
      concatMap(async (responseValue) => {
        await this.write(req, action, responseValue);
        return responseValue;
      }),
    );
  }

  private async write(
    req: Request & { user?: AuthenticatedUser },
    action: string,
    responseValue: unknown,
  ): Promise<void> {
    try {
      const user = req.user;
      if (!user) {
        // Should never happen on an authenticated route, but never throw.
        return;
      }

      const { resourceType, resourceId } = deriveResource(req, responseValue);

      await this.audit.record({
        tenantId: user.tenantId,
        actorType: 'user',
        actorId: user.id,
        action,
        resourceType,
        resourceId,
        changes: buildChanges(req),
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    } catch (err) {
      // Belt-and-suspenders: AuditService.record already swallows errors,
      // but if the service itself threw during construction/injection, catch here.
      // The handler's response still flows through (the row return is unaffected).
      this.logger.error(
        `AuditInterceptor write failed for action="${action}"`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
