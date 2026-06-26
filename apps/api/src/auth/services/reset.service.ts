/**
 * ResetService (SECURITY-CRITICAL).
 *
 * forgot(email): per-destination-email rate cap (independent of IP, anti-bombing)
 *   AND a per-source-IP cap (anti distinct-email spray) — both gates run BEFORE the
 *   user lookup, so an over-cap 429 is existence-independent. On the uncapped path
 *   the controller returns 202 regardless of existence; mail is dispatched
 *   asynchronously (off the response path) so the 202 latency does not depend on
 *   whether the account exists (no SMTP timing oracle).
 *
 * reset(token, newPassword): per-source-IP throttle + a cheap indexed pre-check
 *   BEFORE the memory-hard Argon2id hash (an invalid token cannot burn Argon2),
 *   then the atomic single-use consume below.
 *
 * reset(token, newPassword): atomic single-use consume
 *   `UPDATE password_reset_tokens SET consumed_at = now()
 *      WHERE token_hash = :h AND consumed_at IS NULL AND expires_at > now()
 *      RETURNING user_id, tenant_id`
 *   (0 rows ⇒ invalid/expired/already-used). On success, in the SAME transaction:
 *   set the new Argon2id password hash, BUMP `users.token_version` (kills every
 *   live access token), and revoke ALL of that user's refresh tokens.
 *
 * The reset token and reset URL are NEVER logged.
 */
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../redis/redis.service';
import { users } from '../../database/schema/users';
import { refreshTokens } from '../../database/schema/sessions';
import { passwordResetTokens } from '../../database/schema/password_reset_tokens';
import { systemState } from '../../database/schema/system_state';
import { AuditService } from '../../audit/audit.service';
import { MAIL_SERVICE, type IMailService } from '../../mail/mail.service';
import { RateLimitService } from './rate-limit.service';
import { PasswordService } from './password.service';
import { isBreachedPassword } from './breached-passwords';

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const TOKEN_BYTES = 32;
/** Per-destination-email cap (independent of IP) — anti email-bombing. */
const EMAIL_CAP = 3;
const EMAIL_CAP_WINDOW_SECONDS = 60 * 60; // 3/hour
/**
 * Companion per-SOURCE-IP cap on `forgot`: the per-email cap does nothing against
 * one IP spraying many DISTINCT emails (each existing one costs a token-row INSERT
 * + a mail dispatch). Generous enough not to hurt shared-NAT users (reset is rare)
 * while bounding SMTP-relay abuse from a single source.
 */
const FORGOT_IP_CAP = 30;
const FORGOT_IP_WINDOW_SECONDS = 60 * 60; // 30/hour per IP
/**
 * Per-SOURCE-IP cap on `reset` (token consume). The endpoint is public and runs a
 * memory-hard Argon2id hash, so it must be throttled against an unauthenticated
 * CPU/memory DoS (in addition to the cheap pre-validation below).
 */
const RESET_IP_LIMIT = 10;
const RESET_IP_WINDOW_SECONDS = 60; // 10/minute per IP

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class ResetService {
  private readonly logger = new Logger(ResetService.name);
  private defaultTenantId: string | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
    private readonly passwords: PasswordService,
    private readonly redis: RedisService,
    @Inject(MAIL_SERVICE) private readonly mail: IMailService,
  ) {}

  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private static emailKey(email: string): string {
    return createHash('sha256').update(email).digest('hex');
  }

  private async getDefaultTenantId(): Promise<string> {
    if (this.defaultTenantId) {
      return this.defaultTenantId;
    }
    const [row] = await this.database.db
      .select({ value: systemState.value })
      .from(systemState)
      .where(eq(systemState.key, 'default_tenant_id'))
      .limit(1);
    if (!row || typeof row.value !== 'string') {
      throw new Error('default_tenant_id is not set in system_state');
    }
    this.defaultTenantId = row.value;
    return this.defaultTenantId;
  }

  /**
   * Begin a password reset. Caps requests per destination email (independent of
   * IP) and, if the account exists, mints a token + sends mail. Always resolves
   * the same way — the controller returns 202 regardless (anti-enumeration).
   */
  async forgot(email: string, ctx: RequestContext): Promise<void> {
    const tenantId = await this.getDefaultTenantId();

    // Both rate gates run BEFORE the user lookup, so a 429 fires purely on request
    // VOLUME (per destination-email-hash, and per source IP) and is identical
    // whether or not the account exists — NOT an enumeration oracle. The normal,
    // uncapped path still returns a uniform 202 regardless of existence.

    // (a) Per-destination-email cap — blocks IP-rotation bombing of one inbox.
    const emailCap = await this.rateLimit.check(`reset:email:${ResetService.emailKey(email)}`, {
      limit: EMAIL_CAP,
      windowSeconds: EMAIL_CAP_WINDOW_SECONDS,
    });
    if (!emailCap.allowed) {
      this.logger.warn('password reset throttled: per-email cap');
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    // (b) Per-source-IP cap — blocks one IP spraying many distinct emails.
    const ipCap = await this.rateLimit.check(`reset:ip:${ctx.ip ?? 'unknown'}`, {
      limit: FORGOT_IP_CAP,
      windowSeconds: FORGOT_IP_WINDOW_SECONDS,
    });
    if (!ipCap.allowed) {
      this.logger.warn('password reset throttled: per-IP cap');
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    const [user] = await this.database.db
      .select({ id: users.id, email: users.email, tenantId: users.tenantId })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
      .limit(1);

    await this.audit.record({
      tenantId,
      actorType: user ? 'user' : 'anonymous',
      actorId: user?.id,
      action: 'auth.password.reset_requested',
      resourceType: 'user',
      resourceId: user?.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    if (!user) {
      // Unknown email: no token, no mail. Equal external behaviour (202).
      return;
    }

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    await this.database.db.insert(passwordResetTokens).values({
      tenantId: user.tenantId,
      userId: user.id,
      tokenHash: ResetService.hash(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    });

    // Test-only seam: when running under NODE_ENV=test with
    // RESET_TOKEN_SINK==='1', mirror the plaintext token to Redis so the
    // integration harness can drive /reset (email is mocked). HARD-gated on
    // NODE_ENV==='test' so production can never expose the plaintext this way.
    if (process.env.NODE_ENV === 'test' && process.env.RESET_TOKEN_SINK === '1') {
      await this.redis.client.set(
        `test:last-reset-token:${user.id}`,
        token,
        'EX',
        Math.floor(RESET_TTL_MS / 1000),
      );
    }

    // Dispatch mail OFF the response path. Awaiting the SMTP round-trip here would
    // make the 202 latency depend on existence (the unknown-email branch returns
    // immediately), i.e. a timing oracle. Fire-and-forget keeps both branches'
    // response timing aligned; a send failure is logged, never surfaced.
    const resetUrl = this.buildResetUrl(token);
    void this.mail.sendPasswordReset(user.email, resetUrl).catch((err: unknown) => {
      this.logger.warn(
        `password reset mail dispatch failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    });
  }

  /**
   * Consume a reset token and set a new password. Atomic single-use; on success
   * bumps token_version and revokes all refresh tokens in one transaction. Throws
   * `BadRequestException` on an invalid/expired/used token or a policy violation
   * (generic — does not distinguish which token failed).
   */
  async reset(token: string, newPassword: string, ctx: RequestContext): Promise<void> {
    // (1) Per-IP throttle FIRST — this public endpoint runs a memory-hard Argon2id
    //     hash, so it must be bounded against an unauthenticated CPU/memory DoS.
    //     Fail-closed (RateLimitService blocks on a Redis error).
    const ipGate = await this.rateLimit.check(`reset:consume:${ctx.ip ?? 'unknown'}`, {
      limit: RESET_IP_LIMIT,
      windowSeconds: RESET_IP_WINDOW_SECONDS,
    });
    if (!ipGate.allowed) {
      this.logger.warn('password reset consume throttled: per-IP cap');
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    // (2) Offline policy check (in-memory, no DB / network egress).
    if (isBreachedPassword(newPassword)) {
      throw new BadRequestException('password is too weak');
    }

    const hash = ResetService.hash(token);

    // (3) Cheap, indexed existence pre-check BEFORE the memory-hard Argon2 hash, so
    //     a well-formed-but-invalid token cannot burn Argon2 work. The atomic
    //     consume in the transaction below still re-checks under a row lock, so this
    //     pre-check does NOT weaken the single-use / TOCTOU guarantee.
    const [candidate] = await this.database.db
      .select({ userId: passwordResetTokens.userId })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, hash),
          isNull(passwordResetTokens.consumedAt),
          gt(passwordResetTokens.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    if (!candidate) {
      throw new BadRequestException('invalid or expired reset token');
    }

    const newHash = await this.passwords.hash(newPassword);

    const outcome = await this.database.db.transaction(async (tx) => {
      // Atomic single-use consume: only an unconsumed, unexpired token is claimed.
      const consumed = await tx
        .update(passwordResetTokens)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(passwordResetTokens.tokenHash, hash),
            isNull(passwordResetTokens.consumedAt),
            gt(passwordResetTokens.expiresAt, sql`now()`),
          ),
        )
        .returning({
          userId: passwordResetTokens.userId,
          tenantId: passwordResetTokens.tenantId,
        });

      const row = consumed[0];
      if (!row) {
        return null; // invalid / expired / already used
      }

      // Set new hash + bump token_version (invalidates all live access tokens).
      await tx
        .update(users)
        .set({ passwordHash: newHash, tokenVersion: sql`${users.tokenVersion} + 1` })
        .where(and(eq(users.id, row.userId), eq(users.tenantId, row.tenantId)));

      // Revoke every refresh token for the user (logout everywhere).
      await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(refreshTokens.userId, row.userId),
            eq(refreshTokens.tenantId, row.tenantId),
            isNull(refreshTokens.revokedAt),
          ),
        );

      return row;
    });

    if (!outcome) {
      throw new BadRequestException('invalid or expired reset token');
    }

    await this.audit.record({
      tenantId: outcome.tenantId,
      actorType: 'user',
      actorId: outcome.userId,
      action: 'auth.password.reset_completed',
      resourceType: 'user',
      resourceId: outcome.userId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  /** Build the reset link from server config ONLY (never request Host header). */
  private buildResetUrl(token: string): string {
    const base = process.env.ADMIN_RESET_URL ?? process.env.ADMIN_ORIGIN ?? 'http://localhost:5173';
    const origin = base.split(',')[0]?.trim() ?? 'http://localhost:5173';
    return `${origin.replace(/\/$/, '')}/auth/reset-password?token=${token}`;
  }
}
