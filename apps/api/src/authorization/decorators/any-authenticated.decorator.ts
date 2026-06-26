/**
 * `@AnyAuthenticated`.
 *
 * Marks a route that ANY authenticated principal may access regardless of role —
 * self-service routes (`/me`, `/2fa/*`) that are not tied to a resource
 * permission. Without this marker (and without `@RequirePermission`) the global
 * {@link ../guards/permissions.guard} FAILS CLOSED (403): a route is never
 * silently open just because a permission was forgotten. Unique `Symbol` key.
 */
import { SetMetadata, CustomDecorator } from '@nestjs/common';

/** Unique metadata key for the any-authenticated opt-in. */
export const ANY_AUTHENTICATED_KEY = Symbol('authz:anyAuthenticated');

export const AnyAuthenticated = (): CustomDecorator<symbol> =>
  SetMetadata(ANY_AUTHENTICATED_KEY, true);
