/**
 * SetupTokenGuard (SECURITY-CRITICAL).
 *
 * The single chokepoint for setup-step endpoints (admin creation, store config,
 * install-completion). The guard admits a request ONLY when BOTH hold:
 *   (a) the system is NOT installed, AND
 *   (b) the `X-Setup-Token` header matches a LIVE (unexpired, unused) token.
 *
 * POST-INSTALL LOCKDOWN: once `system_state.installed === true`,
 * every guarded `/setup/v1/*` route returns **404 Not Found** — NOT 403 — to hide
 * the very existence of the setup surface from a post-install probe. `GET
 * /setup/v1/status` is intentionally NOT guarded, so it stays reachable always.
 *
 * A missing/invalid token on a not-installed system is a 404 too: surfacing 401/403
 * would confirm "the setup endpoint exists and just needs the right token", a
 * weaker posture than uniformly hiding the surface. The token has 256 bits of
 * entropy, so it is not brute-forceable; verify-token (the only place a token is
 * checked by request) is additionally rate-limited at the controller.
 */
import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { SetupStateService } from '../setup-state.service';
import { SetupTokenService } from '../setup-token.service';

const SETUP_TOKEN_HEADER = 'x-setup-token';

@Injectable()
export class SetupTokenGuard implements CanActivate {
  constructor(
    private readonly state: SetupStateService,
    private readonly tokens: SetupTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // (a) Post-install lockdown: hide the surface entirely. 404, never 403.
    if (await this.state.isInstalled()) {
      throw new NotFoundException();
    }

    // (b) Require a live X-Setup-Token. Absent/invalid ⇒ 404 (uniform hiding).
    const header = context.switchToHttp().getRequest<Request>().headers[SETUP_TOKEN_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (typeof token !== 'string' || token.length === 0) {
      throw new NotFoundException();
    }

    const { valid } = await this.tokens.verifyToken(token);
    if (!valid) {
      throw new NotFoundException();
    }
    return true;
  }
}
