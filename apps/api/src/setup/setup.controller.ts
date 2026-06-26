/**
 * SetupController (SECURITY-CRITICAL).
 *
 * Base path `/setup/v1`. Both routes are `@Public()` so the global fail-closed
 * JwtAuthGuard / PermissionsGuard skip them — setup must work BEFORE any admin
 * credential exists. Nothing else is loosened: only these two explicit routes opt
 * out, and neither returns the plaintext token.
 *
 *   GET  /setup/v1/status        → { installed, requiresToken } — always reachable,
 *                                  even post-install (so a probe can learn the
 *                                  system is already set up and stop).
 *   POST /setup/v1/verify-token  → { valid, expiresAt } — VALIDATE ONLY, does NOT
 *                                  consume the token. Rate-limited per source IP
 *                                  against brute force (entropy makes it infeasible
 *                                  anyway, but hygiene + DoS bound).
 *
 * The setup-step endpoints (admin creation, install completion) sit behind
 * {@link SetupTokenGuard} and are in their respective controllers.
 */
import { Body, Controller, Get, HttpCode, NotFoundException, Post, Req } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { SetupStateService } from './setup-state.service';
import { SetupTokenService } from './setup-token.service';
import { VerifyTokenDto } from './dto/verify-token.dto';

/** Per-source-IP cap on verify-token: a public, unauthenticated probe surface. */
const VERIFY_IP_LIMIT = 20;
const VERIFY_IP_WINDOW_SECONDS = 60; // 20/minute per IP

@Controller('setup/v1')
export class SetupController {
  constructor(
    private readonly state: SetupStateService,
    private readonly tokens: SetupTokenService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Install state. `requiresToken` is simply `!installed`. Always reachable. */
  @Public()
  @Get('status')
  async status(): Promise<{ installed: boolean; requiresToken: boolean }> {
    const installed = await this.state.isInstalled();
    return { installed, requiresToken: !installed };
  }

  /**
   * Validate-only token check. Never consumes the token; returns its expiry when
   * live. Rate-limited per source IP (fail-closed — RateLimitService blocks on a
   * Redis error). Returns `{ valid:false, expiresAt:null }` for any
   * garbage/expired/used token — no token value is ever echoed back.
   *
   * Post-install the whole setup surface is closed except GET /status, so once installed this 404s
   * BEFORE any rate-limit or token processing — consistent with SetupTokenGuard's
   * hide-existence posture; an installed system reveals nothing here that /status doesn't.
   */
  @Public()
  @Post('verify-token')
  @HttpCode(200)
  async verifyToken(
    @Body() dto: VerifyTokenDto,
    @Req() req: Request,
  ): Promise<{ valid: boolean; expiresAt: string | null }> {
    if (await this.state.isInstalled()) {
      throw new NotFoundException();
    }

    const gate = await this.rateLimit.check(`setup:verify:${req.ip ?? 'unknown'}`, {
      limit: VERIFY_IP_LIMIT,
      windowSeconds: VERIFY_IP_WINDOW_SECONDS,
    });
    if (!gate.allowed) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    const { valid, expiresAt } = await this.tokens.verifyToken(dto.token);
    return { valid, expiresAt };
  }
}
