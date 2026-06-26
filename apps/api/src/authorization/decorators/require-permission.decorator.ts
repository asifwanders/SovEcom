/**
 * `@RequirePermission`.
 *
 * Declares the single permission a route requires. The global
 * {@link ../guards/permissions.guard} reads it and denies (403) any principal
 * whose role does not hold it. The metadata key is a unique `Symbol` (not a
 * forgeable string), matching the `@Public()` convention.
 */
import { SetMetadata, CustomDecorator } from '@nestjs/common';
import type { Permission } from '../permissions.constants';

/** Unique metadata key carrying the required permission. */
export const PERMISSION_KEY = Symbol('authz:requiredPermission');

export const RequirePermission = (permission: Permission): CustomDecorator<symbol> =>
  SetMetadata(PERMISSION_KEY, permission);
