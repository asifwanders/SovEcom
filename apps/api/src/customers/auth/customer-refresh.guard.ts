/**
 * CustomerRefreshGuard (SECURITY-CRITICAL, mirrors JwtRefreshGuard).
 *
 * Protects the customer `/refresh` + `/logout` routes. FAIL-CLOSED at its own
 * boundary (it never relies on the absence of a global guard):
 *   - the httpOnly customer refresh cookie MUST be present (401 otherwise); the
 *     raw token is stashed on `req.refreshToken` for the service to hash + look up.
 *   - CSRF defense-in-depth: a `Sec-Fetch-Site: cross-site` is rejected, and a
 *     present `Origin` must be in the configured STORE-origin allowlist
 *     (`STORE_ORIGIN`, comma-separated). SameSite=Strict on the cookie is the
 *     primary defence; this is the belt to its braces. The cookie is never logged.
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

/** Name of the httpOnly customer refresh cookie (distinct from admin `sov_refresh`). */
export const CUSTOMER_REFRESH_COOKIE = 'sov_customer_refresh';

interface RequestWithRefresh extends Request {
  refreshToken?: string;
}

@Injectable()
export class CustomerRefreshGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {
    // F6: STORE_ORIGIN is REQUIRED in production. Without it, every Origin-bearing
    // request would 403 (the allowlist is empty) — a silent prod breakage. Fail at
    // BOOT instead, exactly like TokenService rejects a missing JWT_SECRET in prod.
    if (process.env.NODE_ENV === 'production') {
      const raw = this.config.get<string>('STORE_ORIGIN');
      if (!raw || raw.trim().length === 0) {
        throw new Error('STORE_ORIGIN must be set in production (customer refresh CSRF allowlist)');
      }
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithRefresh>();
    this.assertSameSite(request);

    const token = request.cookies?.[CUSTOMER_REFRESH_COOKIE];
    if (!token || typeof token !== 'string') {
      throw new UnauthorizedException();
    }
    request.refreshToken = token;
    return true;
  }

  private assertSameSite(request: RequestWithRefresh): void {
    if (request.headers['sec-fetch-site'] === 'cross-site') {
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

  /** Configured store origin(s) — comma-separated `STORE_ORIGIN` env. */
  private allowedOrigins(): string[] {
    const raw = this.config.get<string>('STORE_ORIGIN');
    if (!raw) {
      return [];
    }
    return raw
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  }
}
