/**
 * AuthService (SECURITY-CRITICAL).
 *
 * Orchestrates login (enumeration- & timing-safe), 2FA challenge verification,
 * refresh-token family rotation with reuse detection, and logout. All the crypto
 * primitives live in the dedicated services (token/password/two-factor/challenge
 * /rate-limit/aead); this layer wires them with the exact security ordering the
 * threat model requires. Every event is audited; NO secret is ever logged.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { users, type User } from '../../database/schema/users';
import { refreshTokens } from '../../database/schema/sessions';
import { systemState } from '../../database/schema/system_state';
import { AuditService } from '../../audit/audit.service';
import { TokenService } from './token.service';
import { PasswordService } from './password.service';
import { TwoFactorService } from './two-factor.service';
import { ChallengeService } from './challenge.service';
import { RateLimitService } from './rate-limit.service';

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_SECONDS = 60;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;
// Second-factor guessing budget. Keyed on the ACCOUNT (not IP) so an attacker who
// holds the password cannot brute the 6-digit TOTP by re-minting challenges and
// rotating source IPs. Consistent with the login throttle (10 / 60s) and fails
// CLOSED via RateLimitService just like login.
const TWO_FA_LIMIT = LOGIN_LIMIT;
const TWO_FA_WINDOW_SECONDS = LOGIN_WINDOW_SECONDS;

/** Result of a login attempt: either a 2FA challenge or a minted session. */
export type LoginResult =
  | { requires2FA: true; challengeId: string }
  | { requires2FA: false; accessToken: string; refreshToken: string };

/** Result of a successful refresh: a fresh access token + rotated refresh. */
export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
}

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private defaultTenantId: string | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordService,
    private readonly twoFactor: TwoFactorService,
    private readonly challenges: ChallengeService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  /** Salted hash of an attempted email for audit rows (never plaintext). */
  private static emailAuditHash(email: string): string {
    const salt = AuthService.auditEmailSalt();
    return createHash('sha256').update(`${salt}:${email}`).digest('hex');
  }

  /**
   * Resolve the audit-email salt. In production a missing salt is a HARD failure:
   * an absent/known-default salt makes the audit hashes globally precomputable
   * (defeating the salted-hash privacy guarantee). Dev/test fall back to
   * a fixed value so the harness runs without extra env plumbing.
   */
  private static auditEmailSalt(): string {
    const salt = process.env.AUDIT_EMAIL_SALT;
    if (process.env.NODE_ENV === 'production') {
      if (!salt || salt.length < 16) {
        throw new Error('AUDIT_EMAIL_SALT must be set (>= 16 chars) in production');
      }
      return salt;
    }
    return salt ?? 'sovecom-audit-email-salt';
  }

  /** Resolve (and cache) the single default tenant id for admin (single-tenant v1). */
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
   * Authenticate admin credentials. Returns a 2FA challenge when 2FA is enabled,
   * otherwise a minted session. Enumeration- & timing-safe: all four failure
   * branches (missing / locked / wrong-pw / throttled) return the SAME generic
   * outcome (`null`) after equal Argon2 work; the controller maps `null` to a
   * uniform 401. Audit writes happen AFTER the decision so they are not a timing
   * oracle.
   */
  async login(email: string, password: string, ctx: RequestContext): Promise<LoginResult | null> {
    const tenantId = await this.getDefaultTenantId();
    const emailHash = AuthService.emailAuditHash(email);

    // (1) Throttle gate — fails CLOSED (RateLimitService blocks on Redis error).
    const throttle = await this.rateLimit.check(`login:${ctx.ip ?? 'unknown'}:${emailHash}`, {
      limit: LOGIN_LIMIT,
      windowSeconds: LOGIN_WINDOW_SECONDS,
    });
    if (!throttle.allowed) {
      // Burn the same Argon2 work so throttled is timing-indistinguishable.
      await this.passwords.dummyVerify(password);
      await this.audit.record({
        tenantId,
        actorType: 'anonymous',
        action: 'auth.login.throttled',
        resourceType: 'user',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        changes: { emailHash },
      });
      return null;
    }

    // (2) Look up the user within the default tenant.
    const [user] = await this.database.db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.email, email)))
      .limit(1);

    // (3) Missing user: spend equal time (dummy verify), uniform failure.
    if (!user) {
      await this.passwords.dummyVerify(password);
      await this.audit.record({
        tenantId,
        actorType: 'anonymous',
        action: 'auth.login.failed',
        resourceType: 'user',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        changes: { emailHash, reason: 'unknown_email' },
      });
      return null;
    }

    const locked = AuthService.isLocked(user);
    const passwordOk = await this.passwords.verify(user.passwordHash, password);

    // (4) Wrong password: count a failure (may trip the soft lock), uniform fail.
    if (!passwordOk) {
      await this.recordFailure(user, ctx);
      return null;
    }

    // Correct credentials. The soft lock is NON-remote-lockable: correct
    // creds bypass `locked_until` so an attacker cannot DoS a victim out of their
    // own valid password. We only block wrong-credential attempts on a lock.
    if (locked) {
      this.logger.warn(`login on soft-locked account succeeded with correct credentials`);
    }

    // 2FA enrolled -> mint a stateful, IP-bound, single-use challenge (NOT a JWT).
    if (user.totpEnabled) {
      const challengeId = await this.challenges.create(user.id, user.tenantId, ctx.ip ?? 'unknown');
      await this.audit.record({
        tenantId: user.tenantId,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.login.2fa_required',
        resourceType: 'user',
        resourceId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { requires2FA: true, challengeId };
    }

    // No 2FA -> issue the session now.
    await this.recordSuccess(user.id, user.tenantId);
    const session = await this.issueSession(user.id, user.tenantId, user.role, user.tokenVersion);
    await this.audit.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.login.success',
      resourceType: 'user',
      resourceId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { requires2FA: false, ...session };
  }

  /**
   * Verify a 2FA challenge + TOTP code and mint the session. The challenge is
   * single-use and IP-bound; a wrong/expired/mismatched challenge or a failed /
   * replayed TOTP returns `null` (controller -> uniform 401).
   */
  async verify2fa(
    challengeId: string,
    totpCode: string,
    ctx: RequestContext,
  ): Promise<RefreshResult | null> {
    const consumed = await this.challenges.consume(challengeId, ctx.ip ?? 'unknown');
    if (!consumed) {
      return null;
    }

    // Per-ACCOUNT second-factor throttle — keyed on the user id, NOT the IP,
    // so re-minting challenges and rotating source IPs cannot widen the TOTP-guessing
    // budget. Fails CLOSED (RateLimitService blocks on Redis error). Checked BEFORE
    // verifying the code so a throttled attacker never gets a verification oracle.
    const throttle = await this.rateLimit.check(`2fa:${consumed.userId}`, {
      limit: TWO_FA_LIMIT,
      windowSeconds: TWO_FA_WINDOW_SECONDS,
    });
    if (!throttle.allowed) {
      return null;
    }

    // Re-load the user fresh (the challenge only carried ids).
    const [user] = await this.database.db
      .select()
      .from(users)
      .where(and(eq(users.id, consumed.userId), eq(users.tenantId, consumed.tenantId)))
      .limit(1);
    if (!user) {
      return null;
    }

    // Persistent soft lock also gates the second factor: a wrong-credential attacker
    // who has tripped the account lock cannot keep guessing TOTP codes.
    if (AuthService.isLocked(user)) {
      return null;
    }

    const ok = await this.twoFactor.verify({ id: user.id, totpSecret: user.totpSecret }, totpCode);
    if (!ok) {
      // A failed second factor is a credential failure: count it on the SAME
      // failed_attempts / locked_until path wrong-password uses, so second-factor
      // guessing trips the lockout too. `recordFailure` audits the generic failure.
      await this.recordFailure(user, ctx, '2fa_failed');
      return null;
    }

    await this.recordSuccess(user.id, user.tenantId);
    const session = await this.issueSession(user.id, user.tenantId, user.role, user.tokenVersion);
    await this.audit.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.login.success',
      resourceType: 'user',
      resourceId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      changes: { via: '2fa' },
    });
    return session;
  }

  /**
   * Rotate a refresh token. The atomic gate is a single conditional UPDATE
   * (`... WHERE token_hash = :h AND revoked_at IS NULL RETURNING family_id ...`).
   * 0 rows updated AND a row exists for the hash ⇒ the token was already revoked
   * ⇒ REUSE: revoke the WHOLE family and fail. Otherwise mint a new token in the
   * SAME family. Two concurrent rotations of one token deterministically resolve
   * to exactly one winner (the conditional UPDATE is the serialization point).
   */
  async refresh(rawToken: string, ctx: RequestContext): Promise<RefreshResult | null> {
    const hash = TokenService.hashToken(rawToken);

    return this.database.db.transaction(async (tx) => {
      // Atomic revoke-on-use. Only an active (revoked_at IS NULL) row is claimed.
      // F3: scope to the ADMIN branch (user_id NOT NULL) so a CUSTOMER refresh
      // token presented here is NEVER claimed/revoked — otherwise it would later
      // trip reuse-detection on the customer's real family.
      const revoked = await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(refreshTokens.tokenHash, hash),
            isNull(refreshTokens.revokedAt),
            isNotNull(refreshTokens.userId),
          ),
        )
        .returning({
          familyId: refreshTokens.familyId,
          userId: refreshTokens.userId,
          tenantId: refreshTokens.tenantId,
          expiresAt: refreshTokens.expiresAt,
        });

      const claimed = revoked[0];
      if (!claimed) {
        // 0 rows. Either the token never existed, it was already revoked, or it is
        // a customer token (which this admin surface must not touch — F3).
        const [existing] = await tx
          .select({
            familyId: refreshTokens.familyId,
            userId: refreshTokens.userId,
            tenantId: refreshTokens.tenantId,
          })
          .from(refreshTokens)
          .where(and(eq(refreshTokens.tokenHash, hash), isNotNull(refreshTokens.userId)))
          .limit(1);
        if (existing) {
          // REUSE of an already-rotated token -> revoke the entire family.
          await tx
            .update(refreshTokens)
            .set({ revokedAt: sql`now()` })
            .where(
              and(eq(refreshTokens.familyId, existing.familyId), isNull(refreshTokens.revokedAt)),
            );
          // tenant_id is the family's real tenant (audit_log.tenant_id is a
          // NOT-NULL FK) — never a literal placeholder.
          await this.audit.record({
            tenantId: existing.tenantId,
            actorType: existing.userId ? 'user' : 'anonymous',
            actorId: existing.userId ?? undefined,
            action: 'auth.refresh.reuse_detected',
            resourceType: 'refresh_token_family',
            resourceId: existing.familyId,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
        return null;
      }

      // Expiry check (the row was active but may be past its TTL).
      if (!claimed.userId || claimed.expiresAt.getTime() <= Date.now()) {
        return null;
      }

      // Re-load the user to mint a current access token (role/tv may have changed).
      const [user] = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, claimed.userId), eq(users.tenantId, claimed.tenantId)))
        .limit(1);
      if (!user) {
        return null;
      }

      const minted = this.tokens.issueRefreshToken();
      await tx.insert(refreshTokens).values({
        tenantId: user.tenantId,
        userId: user.id,
        familyId: claimed.familyId, // same lineage
        tokenHash: minted.hash,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      });
      const accessToken = await this.tokens.issueAccessToken({
        id: user.id,
        tenantId: user.tenantId,
        role: user.role,
        tokenVersion: user.tokenVersion,
      });

      await this.audit.record({
        tenantId: user.tenantId,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.refresh',
        resourceType: 'user',
        resourceId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        changes: { familyId: claimed.familyId },
      });
      return { accessToken, refreshToken: minted.plaintext };
    });
  }

  /**
   * Log out: revoke the presented token's whole family (so a stolen sibling can't
   * be rotated) and clear the cookie at the controller. Idempotent — an unknown
   * or already-revoked token is a silent 204.
   */
  async logout(rawToken: string, ctx: RequestContext): Promise<void> {
    const hash = TokenService.hashToken(rawToken);
    // F3: scope to the ADMIN branch (user_id NOT NULL) — a customer token at the
    // admin logout endpoint must be a silent no-op, not revoke the customer family.
    const [row] = await this.database.db
      .select({
        familyId: refreshTokens.familyId,
        userId: refreshTokens.userId,
        tenantId: refreshTokens.tenantId,
      })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, hash), isNotNull(refreshTokens.userId)))
      .limit(1);
    if (!row) {
      return;
    }
    await this.database.db
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
    await this.audit.record({
      tenantId: row.tenantId,
      actorType: row.userId ? 'user' : 'anonymous',
      actorId: row.userId ?? undefined,
      action: 'auth.logout',
      resourceType: 'user',
      resourceId: row.userId ?? undefined,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      changes: { familyId: row.familyId },
    });
  }

  /** Mint a fresh access + refresh token pair, persisting only the refresh hash. */
  private async issueSession(
    userId: string,
    tenantId: string,
    role: string,
    tokenVersion: number,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const minted = this.tokens.issueRefreshToken();
    await this.database.db.insert(refreshTokens).values({
      tenantId,
      userId,
      familyId: minted.familyId,
      tokenHash: minted.hash,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    });
    const accessToken = await this.tokens.issueAccessToken({
      id: userId,
      tenantId,
      role,
      tokenVersion,
    });
    return { accessToken, refreshToken: minted.plaintext };
  }

  private static isLocked(user: User): boolean {
    return user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();
  }

  /** Bump failed_attempts; trip the soft lock at the threshold. Audited on the lock edge. */
  private async recordFailure(
    user: User,
    ctx: RequestContext,
    reason: 'bad_password' | '2fa_failed' = 'bad_password',
  ): Promise<void> {
    const next = user.failedAttempts + 1;
    const trips = next >= LOCKOUT_THRESHOLD;
    await this.database.db
      .update(users)
      .set({
        failedAttempts: next,
        lockedUntil: trips
          ? sql`now() + make_interval(mins => ${LOCKOUT_MINUTES})`
          : user.lockedUntil,
      })
      .where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)));

    await this.audit.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.login.failed',
      resourceType: 'user',
      resourceId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      changes: { reason },
    });
    if (trips && !AuthService.isLocked(user)) {
      await this.audit.record({
        tenantId: user.tenantId,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.account.locked',
        resourceType: 'user',
        resourceId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }
  }

  /** Reset the failure counter + lock and stamp last_login_at on success. */
  private async recordSuccess(userId: string, tenantId: string): Promise<void> {
    await this.database.db
      .update(users)
      .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: sql`now()` })
      .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
  }
}
