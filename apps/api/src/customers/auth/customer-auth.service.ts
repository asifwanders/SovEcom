/**
 * CustomerAuthService (SECURITY-CRITICAL.1).
 *
 * The customer-side mirror of the admin {@link AuthService}: login (enumeration-
 * & timing-safe), refresh (family rotation + reuse-detection on the `customer_id`
 * branch of `refresh_tokens`), and logout. It REUSES the 1.2 primitives exactly:
 *   - PasswordService (argon2id verify + dummyVerify decoy for the unknown branch),
 *   - CustomerTokenService (the `purpose:'customer'` access JWT + opaque refresh
 *     primitive shared via TokenService),
 *   - RateLimitService (fail-closed throttle, checked FIRST),
 *   - AuditService (every event audited AFTER the decision so it is not a timing
 *     oracle; the attempted email is stored only as a salted hash, never plaintext).
 *
 * Customer 2FA is OUT OF SCOPE for 1.8 (the totp columns exist but are unused here).
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { customers, type Customer } from '../../database/schema/customers';
import { refreshTokens } from '../../database/schema/sessions';
import { AuditService } from '../../audit/audit.service';
import { PasswordService } from '../../auth/services/password.service';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { TokenService } from '../../auth/services/token.service';
import { CustomerTokenService } from './customer-token.service';

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_SECONDS = 60;
// Per-ACCOUNT soft lockout (audit A1 / finding #2). MIRRORS the admin constants
// (auth.service.ts LOCKOUT_THRESHOLD / LOCKOUT_MINUTES) exactly. The IP+email throttle
// above is defeated by IP rotation; this counter is keyed on the customer ROW (IP-indep),
// so an attacker rotating source IPs still trips it. A correct password bypasses/clears
// the lock so a victim is never DoS'd out of their own valid credential.
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

export interface CustomerSession {
  accessToken: string;
  refreshToken: string;
}

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly customerTokens: CustomerTokenService,
    private readonly tokens: TokenService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
  ) {}

  /** Salted hash of an attempted email for audit rows (never plaintext). */
  private static emailAuditHash(email: string): string {
    const salt = CustomerAuthService.auditEmailSalt();
    return createHash('sha256').update(`${salt}:${email}`).digest('hex');
  }

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

  /**
   * Authenticate a customer. Enumeration- & timing-safe: throttled / unknown-email /
   * no-password-set / wrong-password all return the SAME `null` after equal Argon2
   * work (the controller maps `null` to a uniform 401). Audit writes happen AFTER
   * the decision. Erased customers are excluded by the active-only lookup, so an
   * anonymized customer is indistinguishable from an unknown one.
   */
  async login(
    tenantId: string,
    email: string,
    password: string,
    ctx: RequestContext,
  ): Promise<CustomerSession | null> {
    const emailHash = CustomerAuthService.emailAuditHash(email);

    // (1) Throttle gate — fails CLOSED.
    const throttle = await this.rateLimit.check(
      `customer-login:${ctx.ip ?? 'unknown'}:${emailHash}`,
      { limit: LOGIN_LIMIT, windowSeconds: LOGIN_WINDOW_SECONDS },
    );
    if (!throttle.allowed) {
      await this.passwords.dummyVerify(password);
      await this.audit.record({
        tenantId,
        actorType: 'anonymous',
        action: 'customer.login.throttled',
        resourceType: 'customer',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        changes: { emailHash },
      });
      return null;
    }

    // (2) Look up the ACTIVE customer (erased rows are invisible -> can't log in).
    const [customer] = await this.database.db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.tenantId, tenantId),
          eq(customers.email, email),
          isNull(customers.deletedAt),
          isNull(customers.anonymizedAt),
        ),
      )
      .limit(1);

    // (3) Unknown customer OR a customer with no password set (e.g. future SSO):
    //     spend equal time, uniform failure.
    if (!customer || !customer.passwordHash) {
      await this.passwords.dummyVerify(password);
      await this.audit.record({
        tenantId,
        actorType: 'anonymous',
        action: 'customer.login.failed',
        resourceType: 'customer',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        changes: { emailHash, reason: 'unknown_or_no_password' },
      });
      return null;
    }

    // (4) Capture the lock state BEFORE verify, then verify (constant-time). Snapshotting
    //     `locked` first mirrors the admin precedent so a correct password can bypass an
    //     active soft lock (anti-DoS) while a wrong one still counts toward it.
    const locked = CustomerAuthService.isLocked(customer);
    const passwordOk = await this.passwords.verify(customer.passwordHash, password);
    if (!passwordOk) {
      // Wrong password: bump the account-keyed counter (may trip the soft lock). The
      // failure is audited inside recordFailure; the outcome stays a uniform null so a
      // locked account is timing/enumeration-indistinguishable (no "account locked"
      // oracle — same as the admin path, which surfaces no lock message either).
      await this.recordFailure(customer, ctx);
      return null;
    }

    // Correct credentials. The soft lock is NON-remote-lockable: a correct
    // password bypasses `locked_until` (and recordSuccess below clears it), so an attacker
    // cannot lock a victim out of their own valid password — only wrong-credential
    // attempts are ever blocked by the lock.
    if (locked) {
      this.logger.warn('customer login on soft-locked account succeeded with correct credentials');
    }

    await this.recordSuccess(customer.id, customer.tenantId);
    const session = await this.issueSession(customer.id, customer.tenantId, customer.tokenVersion);
    await this.audit.record({
      tenantId: customer.tenantId,
      actorType: 'customer',
      actorId: customer.id,
      action: 'customer.login.success',
      resourceType: 'customer',
      resourceId: customer.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return session;
  }

  /**
   * Rotate a customer refresh token. Atomic conditional UPDATE claims the active
   * row; 0 rows + an existing row ⇒ REUSE ⇒ revoke the whole family + fail. Mints
   * a new token in the SAME family otherwise. Mirrors AuthService.refresh exactly,
   * but on the `customer_id` branch (and re-loads the customer, rejecting erased).
   */
  async refresh(rawToken: string, ctx: RequestContext): Promise<CustomerSession | null> {
    const hash = TokenService.hashToken(rawToken);

    return this.database.db.transaction(async (tx) => {
      const revoked = await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        // Scope to the CUSTOMER branch: a mis-presented admin refresh token (which
        // never carries a customer_id) must never be claimed/revoked here.
        .where(
          and(
            eq(refreshTokens.tokenHash, hash),
            isNull(refreshTokens.revokedAt),
            isNotNull(refreshTokens.customerId),
          ),
        )
        .returning({
          familyId: refreshTokens.familyId,
          customerId: refreshTokens.customerId,
          tenantId: refreshTokens.tenantId,
          expiresAt: refreshTokens.expiresAt,
        });

      const claimed = revoked[0];
      if (!claimed) {
        const [existing] = await tx
          .select({
            familyId: refreshTokens.familyId,
            customerId: refreshTokens.customerId,
            tenantId: refreshTokens.tenantId,
          })
          .from(refreshTokens)
          .where(and(eq(refreshTokens.tokenHash, hash), isNotNull(refreshTokens.customerId)))
          .limit(1);
        if (existing) {
          // REUSE of an already-rotated token -> revoke the entire family.
          await tx
            .update(refreshTokens)
            .set({ revokedAt: sql`now()` })
            .where(
              and(eq(refreshTokens.familyId, existing.familyId), isNull(refreshTokens.revokedAt)),
            );
          await this.audit.record({
            tenantId: existing.tenantId,
            actorType: existing.customerId ? 'customer' : 'anonymous',
            actorId: existing.customerId ?? undefined,
            action: 'customer.refresh.reuse_detected',
            resourceType: 'refresh_token_family',
            resourceId: existing.familyId,
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
        }
        return null;
      }

      // This branch is the CUSTOMER one: a token whose subject is a user (admin)
      // must not be rotatable here. Reject (and the row is already revoked above —
      // harmless, it was active and we claimed it; an admin token never carries a
      // customer_id, so this guards a mis-presented admin refresh token).
      if (!claimed.customerId || claimed.expiresAt.getTime() <= Date.now()) {
        return null;
      }

      // Re-load the customer; an erased/anonymized customer cannot refresh.
      const [customer] = await tx
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.id, claimed.customerId),
            eq(customers.tenantId, claimed.tenantId),
            isNull(customers.deletedAt),
            isNull(customers.anonymizedAt),
          ),
        )
        .limit(1);
      if (!customer) {
        return null;
      }

      const minted = this.tokens.issueRefreshToken();
      await tx.insert(refreshTokens).values({
        tenantId: customer.tenantId,
        customerId: customer.id,
        familyId: claimed.familyId,
        tokenHash: minted.hash,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      });
      // Mint with the CURRENT token_version re-read from the row above, so a bump
      // (session-kill) invalidates access tokens even across a refresh rotation.
      const accessToken = await this.customerTokens.issueAccessToken({
        id: customer.id,
        tenantId: customer.tenantId,
        tokenVersion: customer.tokenVersion,
      });

      await this.audit.record({
        tenantId: customer.tenantId,
        actorType: 'customer',
        actorId: customer.id,
        action: 'customer.refresh',
        resourceType: 'customer',
        resourceId: customer.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        changes: { familyId: claimed.familyId },
      });
      return { accessToken, refreshToken: minted.plaintext };
    });
  }

  /**
   * Log out: revoke the presented token's whole family. Idempotent — an unknown /
   * already-revoked token is a silent success.
   */
  async logout(rawToken: string, ctx: RequestContext): Promise<void> {
    const hash = TokenService.hashToken(rawToken);
    const [row] = await this.database.db
      .select({
        familyId: refreshTokens.familyId,
        customerId: refreshTokens.customerId,
        tenantId: refreshTokens.tenantId,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash))
      .limit(1);
    if (!row || !row.customerId) {
      return;
    }
    await this.database.db
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
    await this.audit.record({
      tenantId: row.tenantId,
      actorType: 'customer',
      actorId: row.customerId,
      action: 'customer.logout',
      resourceType: 'customer',
      resourceId: row.customerId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      changes: { familyId: row.familyId },
    });
  }

  /**
   * Mint a fresh access + refresh pair for a customer, persisting only the hash.
   * The access token carries the customer's CURRENT `token_version` (the caller
   * passes it from the authoritative DB row), so a bump invalidates prior tokens.
   */
  async issueSession(
    customerId: string,
    tenantId: string,
    tokenVersion: number,
  ): Promise<CustomerSession> {
    const minted = this.tokens.issueRefreshToken();
    await this.database.db.insert(refreshTokens).values({
      tenantId,
      customerId,
      familyId: minted.familyId,
      tokenHash: minted.hash,
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    });
    const accessToken = await this.customerTokens.issueAccessToken({
      id: customerId,
      tenantId,
      tokenVersion,
    });
    return { accessToken, refreshToken: minted.plaintext };
  }

  /** True iff the account has an unexpired soft lock. Mirrors AuthService.isLocked. */
  private static isLocked(customer: Customer): boolean {
    return customer.lockedUntil !== null && customer.lockedUntil.getTime() > Date.now();
  }

  /**
   * Bump `failed_attempts`; trip the 15-min soft lock at the threshold. Keyed on the
   * customer ROW (tenant-scoped), so it is IP-independent — an attacker rotating source
   * IPs past the first throttle still trips it. Audited on the failure and on the lock
   * edge. Mirrors AuthService.recordFailure.
   */
  private async recordFailure(customer: Customer, ctx: RequestContext): Promise<void> {
    const next = customer.failedAttempts + 1;
    const trips = next >= LOCKOUT_THRESHOLD;
    await this.database.db
      .update(customers)
      .set({
        failedAttempts: next,
        lockedUntil: trips
          ? sql`now() + make_interval(mins => ${LOCKOUT_MINUTES})`
          : customer.lockedUntil,
      })
      .where(and(eq(customers.id, customer.id), eq(customers.tenantId, customer.tenantId)));

    await this.audit.record({
      tenantId: customer.tenantId,
      actorType: 'customer',
      actorId: customer.id,
      action: 'customer.login.failed',
      resourceType: 'customer',
      resourceId: customer.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      changes: { reason: 'bad_password' },
    });
    if (trips && !CustomerAuthService.isLocked(customer)) {
      await this.audit.record({
        tenantId: customer.tenantId,
        actorType: 'customer',
        actorId: customer.id,
        action: 'customer.account.locked',
        resourceType: 'customer',
        resourceId: customer.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }
  }

  /** Reset the failure counter + clear the soft lock on a successful auth. */
  private async recordSuccess(customerId: string, tenantId: string): Promise<void> {
    await this.database.db
      .update(customers)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)));
  }
}
