/**
 *C1 — CustomerPasswordService (AUTH/CREDENTIAL-CRITICAL).
 *
 * The authenticated customer's self-service CHANGE-PASSWORD flow. It composes the
 * existing 1.2/1.8 primitives EXACTLY — no new crypto, no new session mechanics:
 *
 *   - step-up (RgpdService.requireStepUp template): rate-limit 5/60s fail-closed
 *     keyed `…:${ip}:${customerId}`, load the active customer, verify the CURRENT
 *     password with argon2id, `dummyVerify` on the throttle / missing-hash branches
 *     so neither becomes a password oracle. A uniform 401 on every failure path.
 *   - policy (signup / admin reset): min-12 length is enforced at the DTO; the
 *     offline breached-password denylist (`isBreachedPassword`) is enforced here,
 *     mirroring `CustomersService.signup` + `ResetService.reset`.
 *   - rotation (ResetService.reset transaction template): in ONE tx — set the new
 *     argon2id hash + bump `token_version` (kills every OUTSTANDING access token),
 *     revoke EVERY existing refresh token for the customer (logout everywhere),
 *     then INSERT a fresh refresh-token family for the CURRENT session.
 *   - response (login mint): mint a NEW access token carrying the BUMPED
 *     `token_version`, return `{ accessToken }`, and the controller sets the rotated
 *     refresh cookie — so the client that performed the change STAYS logged in while
 *     all OTHER sessions are dead.
 *
 * SESSION-KILL-BUT-KEEP-CURRENT: the bump invalidates ALL access tokens (including
 * the caller's pre-change one) and the revoke kills ALL refresh families; the
 * current session survives ONLY because we mint it a brand-new access token (at the
 * bumped tv) + a brand-new refresh family inside the SAME transaction. There is no
 * window in which the caller holds a valid-but-unrotated credential.
 *
 * The password (current or new) is NEVER logged or stored anywhere but the hash.
 */
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { customers } from '../../database/schema/customers';
import { refreshTokens } from '../../database/schema/sessions';
import { AuditService } from '../../audit/audit.service';
import { PasswordService } from '../../auth/services/password.service';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { TokenService } from '../../auth/services/token.service';
import { isBreachedPassword } from '../../auth/services/breached-passwords';
import { CustomerTokenService } from './customer-token.service';

/** Step-up rate-limit budget (per ip+customer) — mirrors RgpdService.requireStepUp. */
const STEPUP_LIMIT = 5;
const STEPUP_WINDOW_SECONDS = 60;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (matches CustomerAuthService)

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

/** The credential the caller's CURRENT session keeps after the change. */
export interface ChangePasswordResult {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class CustomerPasswordService {
  private readonly logger = new Logger(CustomerPasswordService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly customerTokens: CustomerTokenService,
  ) {}

  /** Salted hash of an email for audit rows (never plaintext, 022.8 — mirrors login). */
  private static emailAuditHash(email: string): string {
    const salt = CustomerPasswordService.auditEmailSalt();
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
   * Change the authenticated customer's password. Verifies `currentPassword`
   * (step-up), enforces the signup password policy on `newPassword`, then in ONE
   * transaction rotates the hash + bumps token_version + revokes every refresh
   * token + mints a fresh family for the CURRENT session. Returns the new access +
   * refresh credentials for the caller (the controller sets the rotated cookie).
   *
   * Failure modes:
   *   - throttled / missing-customer / no-password / wrong-password → uniform 401;
   *   - weak / breached newPassword → 400.
   */
  async changeOwnPassword(
    tenantId: string,
    customerId: string,
    currentPassword: string,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<ChangePasswordResult> {
    // (1) Step-up: rate-limit (fail-closed) → load active customer → verify current
    //     password. Every failure path does equal Argon2 work and throws a uniform
    //     401 — never a password oracle (RgpdService.requireStepUp template).
    const customer = await this.requireStepUp(tenantId, customerId, currentPassword, ctx);

    // (2) Policy: the DTO enforced min-12 / max-1024; enforce the SAME offline
    //     breached-password denylist as signup / admin reset. Non-oracle 400.
    if (isBreachedPassword(newPassword)) {
      throw new BadRequestException('password is too common');
    }
    // Nicety: reject a no-op change (new === current). Only reachable AFTER the
    // current password was verified, so it leaks nothing an attacker doesn't know.
    if (newPassword === currentPassword) {
      throw new BadRequestException('new password must differ from the current password');
    }

    // (3) Hash the new password BEFORE the transaction (memory-hard work off the tx).
    const newHash = await this.passwords.hash(newPassword);

    // (4) Mint the CURRENT session's fresh refresh token (only the hash is persisted).
    const minted = this.tokens.issueRefreshToken();

    // (5) ONE transaction — set hash + bump tv (kills outstanding access tokens),
    //     revoke EVERY refresh token (logout everywhere), INSERT the new family for
    //     the current session. The bumped tv is read back to mint the access token.
    const bumpedTokenVersion = await this.database.db.transaction(async (tx) => {
      const updated = await tx
        .update(customers)
        .set({
          passwordHash: newHash,
          tokenVersion: sql`${customers.tokenVersion} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(customers.id, customerId),
            eq(customers.tenantId, tenantId),
            isNull(customers.deletedAt),
            isNull(customers.anonymizedAt),
          ),
        )
        .returning({ tokenVersion: customers.tokenVersion });

      const row = updated[0];
      if (!row) {
        // The customer was erased between the step-up read and here — abort the tx.
        // (Uniform 401; nothing rotated.)
        throw new UnauthorizedException();
      }

      // Revoke EVERY still-active refresh token for the customer (logout everywhere).
      await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(refreshTokens.customerId, customerId),
            eq(refreshTokens.tenantId, tenantId),
            isNull(refreshTokens.revokedAt),
          ),
        );

      // INSERT a fresh family for the CURRENT session (so it survives the revoke).
      await tx.insert(refreshTokens).values({
        tenantId,
        customerId,
        familyId: minted.familyId,
        tokenHash: minted.hash,
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      });

      return row.tokenVersion;
    });

    // (6) Mint a new access token carrying the BUMPED token_version, so the caller's
    //     current session is valid and every pre-change access token is stale.
    const accessToken = await this.customerTokens.issueAccessToken({
      id: customerId,
      tenantId,
      tokenVersion: bumpedTokenVersion,
    });

    // (7) Audit AFTER the decision (not a timing oracle). Email stored as a salted
    //     hash only; the password (current or new) NEVER enters the audit row.
    //
    //     The credential change is ALREADY durably committed (tx above), so an audit
    //     write failure here must NOT report the request as failed: that would leave
    //     the customer with a changed password + every session killed, yet a 500 and
    //     no returned token (effectively, a confusing forced logout). A
    //     credential-critical change that is durably applied must be reported as
    //     success. We swallow + LOG the audit error (no plaintext) and still return
    //     the rotated credential. (Note: the admin ResetService has the same post-tx
    //     audit shape; this hardens the customer path — an intentional divergence.)
    try {
      await this.audit.record({
        tenantId,
        actorType: 'customer',
        actorId: customerId,
        action: 'customer.password_changed',
        resourceType: 'customer',
        resourceId: customerId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        changes: { emailHash: CustomerPasswordService.emailAuditHash(customer.email) },
      });
    } catch (err) {
      this.logger.error(
        `customer.password_changed audit write failed (change already committed): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }

    return { accessToken, refreshToken: minted.plaintext };
  }

  /**
   * Step-up gate (RgpdService.requireStepUp template): rate-limit (fail-closed) →
   * load the active customer → verify the current password (argon2id). On a missing
   * customer, a customer with no password, or a wrong password, do equal Argon2 work
   * (dummyVerify) and throw a uniform 401 — never a password oracle. Returns the
   * loaded customer row on success.
   */
  private async requireStepUp(
    tenantId: string,
    customerId: string,
    password: string,
    ctx: RequestContext,
  ) {
    // (1) Rate-limit per ip+customer — fails CLOSED (RateLimitService blocks on a
    //     Redis error). Bounds brute-forcing the password through this endpoint.
    const throttle = await this.rateLimit.check(
      `customer-change-password:${ctx.ip ?? 'unknown'}:${customerId}`,
      { limit: STEPUP_LIMIT, windowSeconds: STEPUP_WINDOW_SECONDS },
    );
    if (!throttle.allowed) {
      await this.passwords.dummyVerify(password);
      throw new UnauthorizedException();
    }

    // (2) Load the active customer (erased rows are invisible).
    const [customer] = await this.database.db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.tenantId, tenantId),
          isNull(customers.deletedAt),
          isNull(customers.anonymizedAt),
        ),
      )
      .limit(1);

    // (3) Missing / passwordless customer: equal Argon2 work, uniform 401.
    if (!customer || !customer.passwordHash) {
      await this.passwords.dummyVerify(password);
      throw new UnauthorizedException();
    }

    // (4) Verify the current password (constant-time).
    const ok = await this.passwords.verify(customer.passwordHash, password);
    if (!ok) {
      throw new UnauthorizedException();
    }
    return customer;
  }
}
