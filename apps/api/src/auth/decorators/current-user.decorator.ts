/**
 * `@CurrentUser` param decorator.
 *
 * Returns the DB-loaded principal that {@link JwtAuthGuard} attached to
 * `req.user`. `role` / `tenantId` on this object are from the DB row (the guard
 * never trusts the JWT claim downstream). On a `@Public()` route `req.user` is
 * absent and this returns `undefined`.
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../authenticated-user';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    return request.user;
  },
);
