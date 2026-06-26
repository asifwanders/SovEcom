/**
 * `@Public` route marker (SECURITY-CRITICAL).
 *
 * The global {@link JwtAuthGuard} is FAIL-CLOSED: every route is authenticated
 * unless it carries this marker. The metadata key is a unique `Symbol`, NOT the
 * string `'isPublic'`, so a route cannot be made public by an attacker-controlled
 * string-keyed metadata collision.
 */
import { SetMetadata, CustomDecorator } from '@nestjs/common';

/** Unique, non-forgeable metadata key for the public-route opt-out. */
export const IS_PUBLIC_KEY = Symbol('auth:isPublic');

/**
 * Opt a route out of the global JWT guard. Use sparingly and only on routes that
 * are *intended* to be reachable without an access token (login, refresh, 2fa
 * challenge, forgot/reset password). Each use is covered by the route-coverage
 * invariant test (every route is guarded OR explicitly `@Public()`).
 */
export const Public = (): CustomDecorator<symbol> => SetMetadata(IS_PUBLIC_KEY, true);
