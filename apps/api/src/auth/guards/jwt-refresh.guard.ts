/**
 * JwtRefreshGuard (SECURITY-CRITICAL).
 *
 * Protects `/refresh` and `/logout`. These routes are anonymous-reachable (the
 * access token is expired by the time `/refresh` is called) but the guard is
 * FAIL-CLOSED at its own boundary — it never relies on the absence of the global
 * guard:
 *   - The httpOnly refresh cookie MUST be present (401 otherwise). The raw token
 *     is stashed on `req.refreshToken` for the service to hash + look up.
 *   - Defense-in-depth CSRF check: when an `Origin` header is present it
 *     MUST be in the configured admin-origin allowlist; a `Sec-Fetch-Site` of
 *     `cross-site` is rejected. SameSite=Strict on the cookie is the primary
 *     defence; this is the belt to that cookie's braces.
 *
 * The cookie value itself is never logged.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/** Name of the httpOnly refresh cookie (kept in one place — see controller). */
export const REFRESH_COOKIE = 'sov_refresh';

interface RequestWithRefresh extends Request {
  refreshToken?: string;
}

@Injectable()
export class JwtRefreshGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithRefresh>();

    // CSRF defense-in-depth: reject obviously cross-site requests before
    // touching the cookie. A missing Origin (same-origin GET-less fetch / native
    // client) is allowed; a present Origin must match the allowlist.
    this.assertSameSite(request);

    const token = request.cookies?.[REFRESH_COOKIE];
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException();
    }
    request.refreshToken = token;
    return true;
  }

  private assertSameSite(request: RequestWithRefresh): void {
    const secFetchSite = request.headers['sec-fetch-site'];
    if (secFetchSite === 'cross-site') {
      throw new ForbiddenException();
    }

    const origin = request.headers.origin;
    if (origin) {
      const allowed = this.allowedOrigins();
      if (!allowed.includes(origin)) {
        throw new ForbiddenException();
      }
    }
  }

  /** Configured admin origin(s) — comma-separated `ADMIN_ORIGIN` env. */
  private allowedOrigins(): string[] {
    const raw = this.config.get<string>('ADMIN_ORIGIN');
    if (!raw) {
      return [];
    }
    return raw
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  }
}
