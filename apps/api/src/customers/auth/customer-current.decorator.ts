/**
 * `@CurrentCustomer` param decorator.
 *
 * Returns the DB-loaded principal that {@link CustomerAuthGuard} attached to
 * `req.customer`. `tenantId` is from the DB row (the guard never trusts the JWT
 * claim downstream). On a route without the guard, `req.customer` is absent and
 * this returns `undefined`.
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedCustomer } from './authenticated-customer';

export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedCustomer | undefined => {
    const request = ctx.switchToHttp().getRequest<Request & { customer?: AuthenticatedCustomer }>();
    return request.customer;
  },
);
