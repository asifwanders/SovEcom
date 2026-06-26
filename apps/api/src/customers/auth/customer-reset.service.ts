/**
 *C5 — CustomerResetService (AUTH/CREDENTIAL-CRITICAL).
 *
 * The storefront customer's UNAUTH forgot-password + reset flow. It mirrors the admin
 * `ResetService` two-method shape EXACTLY, but customer-side and with
 * one deliberate divergence at reset (see below). No new crypto, no new session
 * mechanics — it composes the existing 1.2/1.8 primitives:
 *
 *   forgot(tenantId, email): per-destination-email rate cap (independent of IP,
 *     anti-bombing) AND a per-source-IP cap (anti distinct-email spray) — both gates run
 *     BEFORE the customer lookup, so an over-cap 429 is existence-independent. On the
 *     uncapped path the controller returns 202 regardless of existence; mail is dispatched
 *     fire-and-forget (off the response path) so the 202 latency does not depend on
 *     whether the account exists (no SMTP timing oracle). The awaited DB paths are
 *     SHAPE-EQUALIZED: the unknown branch does a dummy indexed token lookup (matches no
 *     row) ≈ the known branch's token INSERT round-trip, so neither the DB work nor the
 *     audit round-trip differs known-vs-unknown (anti-timing-oracle, defense-in-depth on
 *     top of the auth-less rate gates; mirrors admin). A concurrent RGPD-erase racing the
 *     known-branch INSERT (composite-FK 23503) is downgraded to the same silent no-op as
 *     the unknown branch, so an FK violation can never 500-leak existence.
 *
 *   reset(token, newPassword): per-source-IP throttle + a cheap indexed pre-check
 *     BEFORE the memory-hard Argon2id hash (an invalid token cannot burn Argon2), then
 *     the atomic single-use consume below. On success, in ONE transaction: set the new
 *     Argon2id hash, BUMP `customers.token_version` (kills every live access token), and
 *     revoke ALL of the customer's refresh tokens.
 *
 *   DIVERGENCE FROM C1 (change-password): a reset is UNAUTHENTICATED — there is no
 *     current session to keep alive — so it does NOT mint a fresh refresh family. A
 *     successful reset therefore logs out ALL sessions; the customer logs in afresh
 *     with the new password.
 *
 * The reset token plaintext is only emailed + (NODE_ENV=test only) mirrored to Redis via
 * the SAME RESET_TOKEN_SINK seam the admin uses (the key prefix differs); only its
 * SHA-256 hash is persisted. Audit rows store a SALTED hash of the email, never plaintext.
 * The token and reset URL are NEVER logged.
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
import { customers } from '../../database/schema/customers';
import { refreshTokens } from '../../database/schema/sessions';
import { customerPasswordResetTokens } from '../../database/schema/customer_password_reset_tokens';
import { AuditService } from '../../audit/audit.service';
import { PasswordService } from '../../auth/services/password.service';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { isBreachedPassword } from '../../auth/services/breached-passwords';
import { MAIL_SERVICE, type IMailService } from '../../mail/mail.service';
import { resolveEmailLocale } from '../../emails/i18n/email-locale';
import { isForeignKeyViolation } from '../../common/pg-error.util';

const TOKEN_BYTES = 32;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour (mirrors admin)
/** Per-destination-email cap (independent of IP) — anti email-bombing (mirrors admin). */
const EMAIL_CAP = 3;
const EMAIL_CAP_WINDOW_SECONDS = 60 * 60; // 3/hour
/** Companion per-SOURCE-IP cap on `forgot` — bounds one IP spraying many distinct emails. */
const FORGOT_IP_CAP = 30;
const FORGOT_IP_WINDOW_SECONDS = 60 * 60; // 30/hour per IP
/** Per-SOURCE-IP cap on `reset` (token consume) — bounds an unauth Argon2 CPU/memory DoS. */
const RESET_IP_LIMIT = 10;
const RESET_IP_WINDOW_SECONDS = 60; // 10/minute per IP

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class CustomerResetService {
  private readonly logger = new Logger(CustomerResetService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly rateLimit: RateLimitService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    @Inject(MAIL_SERVICE) private readonly mail: IMailService,
  ) {}

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** SHA-256 of an email for the per-destination throttle key (existence-independent). */
  private static emailKey(email: string): string {
    return createHash('sha256').update(email).digest('hex');
  }

  /** Salted hash of an email for audit rows (never plaintext, 022.8 — copied verbatim from). */
  private static emailAuditHash(email: string): string {
    const salt = CustomerResetService.auditEmailSalt();
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
   * Resolve the storefront origin from server config ONLY (never a request Host header).
   * `STORE_ORIGIN` is comma-separated — the SAME env the customer refresh CSRF allowlist
   * uses; the first entry wins. FAILS CLOSED in production (mirrors `auditEmailSalt`'s
   * guard): a missing `STORE_ORIGIN` in prod would mint a localhost reset link, which is
   * a dead link at best and a credential-bearing mis-send at worst. Belt-and-suspenders —
   * the customer-refresh guard already requires STORE_ORIGIN at boot in prod.
   */
  private static storeOrigin(): string {
    const base = process.env.STORE_ORIGIN;
    if (process.env.NODE_ENV === 'production' && !base) {
      throw new Error('STORE_ORIGIN must be set in production (customer reset link base)');
    }
    const origin =
      (base ?? 'http://localhost:3000').split(',')[0]?.trim() || 'http://localhost:3000';
    return origin.replace(/\/$/, '');
  }

  /**
   * Build the storefront reset link from server config ONLY. Mirrors C3's `buildVerifyUrl`.
   * The URL carries a single-use token (never logged): `${origin}/${locale}/reset?token=…`.
   * Points at the C6 storefront reset page.
   */
  private static buildResetUrl(token: string, locale: string): string {
    return `${CustomerResetService.storeOrigin()}/${locale}/reset?token=${encodeURIComponent(token)}`;
  }

  /**
   * Begin a password reset. Caps requests per destination email (independent of IP)
   * AND per source IP, BEFORE the customer lookup, so an over-cap 429 is
   * existence-independent. If the account exists, mints a single-use token + sends the
   * (localized) reset mail. Always resolves the same way — the controller returns 202
   * regardless (anti-enumeration). Returns void.
   *
   * NO account-existence oracle: the rate-limit gates run before the lookup; the audit
   * round-trip is equal on the known + unknown branches; and the mail dispatch is
   * fire-and-forget on the known branch only (so the awaited path is shape-equal).
   */
  async forgot(tenantId: string, email: string, ctx: RequestContext): Promise<void> {
    // Both rate gates run BEFORE the customer lookup, so a 429 fires purely on request
    // VOLUME (per destination-email-hash, and per source IP) and is identical whether or
    // not the account exists — NOT an enumeration oracle. The uncapped path still returns
    // a uniform 202 regardless of existence.

    // (a) Per-destination-email cap — blocks IP-rotation bombing of one inbox.
    const emailCap = await this.rateLimit.check(
      `customer-reset:email:${CustomerResetService.emailKey(email)}`,
      { limit: EMAIL_CAP, windowSeconds: EMAIL_CAP_WINDOW_SECONDS },
    );
    if (!emailCap.allowed) {
      this.logger.warn('customer password reset throttled: per-email cap');
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    // (b) Per-source-IP cap — blocks one IP spraying many distinct emails.
    const ipCap = await this.rateLimit.check(`customer-reset:ip:${ctx.ip ?? 'unknown'}`, {
      limit: FORGOT_IP_CAP,
      windowSeconds: FORGOT_IP_WINDOW_SECONDS,
    });
    if (!ipCap.allowed) {
      this.logger.warn('customer password reset throttled: per-IP cap');
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    // Look up the ACTIVE customer by email in this tenant (erased rows invisible). The
    // email is already lowercased by the DTO; match case-insensitively to be safe.
    const [customer] = await this.database.db
      .select({ id: customers.id, email: customers.email, locale: customers.locale })
      .from(customers)
      .where(
        and(
          eq(customers.tenantId, tenantId),
          sql`lower(${customers.email}) = ${email.toLowerCase()}`,
          isNull(customers.deletedAt),
          isNull(customers.anonymizedAt),
        ),
      )
      .limit(1);

    const emailHash = CustomerResetService.emailAuditHash(email);

    if (!customer) {
      // Unknown email: no token, no mail. Equalize the known-branch token INSERT round-trip
      // with a dummy indexed lookup (anti-timing-oracle, defense-in-depth): a hash of a
      // FRESH random token matches no row, so this is a single indexed SELECT that writes
      // no garbage row. Then audit the request (anonymous actor) so the audit round-trip is
      // ALSO equal vs the known branch. Both are awaited/fire-and-forget identically.
      await this.dummyTokenLookup();
      this.recordRequestAudit(tenantId, undefined, emailHash, ctx, 'anonymous');
      return;
    }

    // Known path: mint a token (only the hash is persisted) and insert a token row. A
    // concurrent RGPD-erase between the active-customer SELECT above and this INSERT fires
    // the composite (customer_id, tenant_id) FK → SQLSTATE 23503. That must NOT 500 on the
    // KNOWN branch only (the unknown branch returns 202): a known-only 500 would break the
    // uniform-202 invariant and LEAK existence. Downgrade an FK violation to the SAME silent
    // no-op as the unknown branch (anonymous audit, no token, no mail) and return 202.
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    try {
      await this.database.db.insert(customerPasswordResetTokens).values({
        tenantId,
        customerId: customer.id,
        tokenHash: CustomerResetService.hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        // The customer was erased mid-flight — treat as "unknown" (silent no-op, uniform
        // 202). No token row exists (the INSERT rolled back), so no mail is sent.
        this.logger.warn(
          'customer password reset: customer erased mid-flight (FK violation) — silent no-op',
        );
        this.recordRequestAudit(tenantId, undefined, emailHash, ctx, 'anonymous');
        return;
      }
      throw err;
    }

    // Test-only seam (mirrors the admin RESET_TOKEN_SINK; REUSE the same env name — the
    // Redis key prefix differs). HARD-gated on NODE_ENV=test so production can never
    // expose the plaintext this way.
    if (process.env.NODE_ENV === 'test' && process.env.RESET_TOKEN_SINK === '1') {
      await this.redis.client.set(
        `test:last-customer-reset-token:${customer.id}`,
        token,
        'EX',
        Math.floor(RESET_TTL_MS / 1000),
      );
    }

    // Dispatch mail OFF the response path. Awaiting the SMTP round-trip here would make
    // the 202 latency depend on existence (the unknown-email branch returns immediately),
    // i.e. a timing oracle. Fire-and-forget keeps both branches' response timing aligned;
    // a send failure is logged, never surfaced. Locale from the customer's stored pref.
    const locale = resolveEmailLocale(customer.locale);
    const resetUrl = CustomerResetService.buildResetUrl(token, locale);
    void this.mail
      .sendCustomerPasswordReset(customer.email, resetUrl, locale)
      .catch((err: unknown) => {
        this.logger.warn(
          `customer password reset mail dispatch failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      });

    // Audit the known branch (customer actor). Fire-and-forget so its round-trip neither
    // 500s a committed request nor adds a timing delta vs the unknown branch.
    this.recordRequestAudit(tenantId, customer.id, emailHash, ctx, 'customer');
  }

  /**
   * Dummy indexed token lookup that matches no row — used on the unknown / FK-no-op
   * branches to shape-match the known branch's token INSERT round-trip (anti-timing-oracle).
   * The hash of a fresh random token cannot collide with any real row.
   */
  private async dummyTokenLookup(): Promise<void> {
    const stray = CustomerResetService.hashToken(randomBytes(TOKEN_BYTES).toString('base64url'));
    await this.database.db
      .select({ id: customerPasswordResetTokens.id })
      .from(customerPasswordResetTokens)
      .where(eq(customerPasswordResetTokens.tokenHash, stray))
      .limit(1);
  }

  /**
   * Fire-and-forget the `customer.password_reset_requested` audit row. Identical shape on
   * the known (`customer` actor) and unknown / FK-no-op (`anonymous` actor) branches so the
   * audit round-trip is equal either way (anti-timing-oracle). Swallows + logs errors so a
   * failed audit never 500s the uniform-202 response (mirrors C1/).
   */
  private recordRequestAudit(
    tenantId: string,
    customerId: string | undefined,
    emailHash: string,
    ctx: RequestContext,
    actorType: 'customer' | 'anonymous',
  ): void {
    void this.audit
      .record({
        tenantId,
        actorType,
        actorId: customerId,
        action: 'customer.password_reset_requested',
        resourceType: 'customer',
        resourceId: customerId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        changes: { emailHash },
      })
      .catch((err: unknown) => {
        this.logger.error(
          `customer.password_reset_requested audit write failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      });
  }

  /**
   * Consume a reset token and set a new password. Atomic single-use; on success bumps
   * token_version and revokes ALL refresh tokens in one transaction (logout everywhere —
   * NO fresh family, the user is unauthenticated). Throws `BadRequestException` on an
   * invalid/expired/used token or a policy violation (generic — does not distinguish
   * which). Returns void (the controller answers 204).
   */
  async reset(token: string, newPassword: string, ctx: RequestContext): Promise<void> {
    // (1) Per-IP throttle FIRST — this public endpoint runs a memory-hard Argon2id hash,
    //     so it must be bounded against an unauthenticated CPU/memory DoS. Fail-closed
    //     (RateLimitService blocks on a Redis error).
    const ipGate = await this.rateLimit.check(`customer-reset:consume:${ctx.ip ?? 'unknown'}`, {
      limit: RESET_IP_LIMIT,
      windowSeconds: RESET_IP_WINDOW_SECONDS,
    });
    if (!ipGate.allowed) {
      this.logger.warn('customer password reset consume throttled: per-IP cap');
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    const hash = CustomerResetService.hashToken(token);

    // (2) Cheap, indexed token existence pre-check FIRST (before the breached-password
    //     denylist lookup AND the memory-hard Argon2 hash), so invalid-token spam
    //     short-circuits with the cheapest possible work — neither the denylist lookup nor
    //     Argon2 is burned on a bogus token. The atomic consume in the transaction below
    //     still re-checks under the conditional UPDATE, so this pre-check does NOT weaken
    //     the single-use / TOCTOU guarantee. Generic 400 (does not say which check failed).
    const [candidate] = await this.database.db
      .select({ customerId: customerPasswordResetTokens.customerId })
      .from(customerPasswordResetTokens)
      .where(
        and(
          eq(customerPasswordResetTokens.tokenHash, hash),
          isNull(customerPasswordResetTokens.consumedAt),
          gt(customerPasswordResetTokens.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    if (!candidate) {
      throw new BadRequestException('invalid or expired reset token');
    }

    // (3) Offline policy check (in-memory, no DB / network egress) — only AFTER the token
    //     is known-valid. The DTO enforced min-12 / max-1024; the breached-password
    //     denylist is enforced here. Same generic 400.
    if (isBreachedPassword(newPassword)) {
      throw new BadRequestException('password is too weak');
    }

    // (4) Hash the new password BEFORE the transaction (memory-hard work off the tx).
    const newHash = await this.passwords.hash(newPassword);

    // (5) ONE transaction: atomic single-use consume → set hash + bump tv (kills every
    //     outstanding access token) → revoke EVERY refresh family (logout everywhere).
    //     NO fresh family insert: the user is unauthenticated at reset (key divergence
    //     from). F5 guard: the customer UPDATE is guarded by `.returning()` — if the
    //     customer was erased between consume and update, throw 400 (rolls back consume).
    const outcome = await this.database.db.transaction(async (tx) => {
      const consumed = await tx
        .update(customerPasswordResetTokens)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(customerPasswordResetTokens.tokenHash, hash),
            isNull(customerPasswordResetTokens.consumedAt),
            gt(customerPasswordResetTokens.expiresAt, sql`now()`),
          ),
        )
        .returning({
          customerId: customerPasswordResetTokens.customerId,
          tenantId: customerPasswordResetTokens.tenantId,
        });

      const row = consumed[0];
      if (!row) {
        return null; // invalid / expired / already used (raced between pre-check + here)
      }

      // Set the new hash + bump token_version (invalidates all live access tokens).
      // Active-only: an already-erased customer matches no row → F5 abort below.
      const updated = await tx
        .update(customers)
        .set({
          passwordHash: newHash,
          tokenVersion: sql`${customers.tokenVersion} + 1`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(customers.id, row.customerId),
            eq(customers.tenantId, row.tenantId),
            isNull(customers.deletedAt),
            isNull(customers.anonymizedAt),
          ),
        )
        .returning({ id: customers.id, email: customers.email });

      const customerRow = updated[0];
      if (!customerRow) {
        // The customer was erased between the consume and the update — abort so the
        // conditional consume rolls back too (mirrors C3's). Uniform 400 below.
        throw new BadRequestException('invalid or expired reset token');
      }

      // Revoke EVERY still-active refresh family for the customer (logout everywhere).
      // No fresh family is minted: a reset is unauthenticated — there is no current
      // session to keep — so ALL sessions die and the user logs in afresh.
      await tx
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(refreshTokens.customerId, row.customerId),
            eq(refreshTokens.tenantId, row.tenantId),
            isNull(refreshTokens.revokedAt),
          ),
        );

      return { customerId: row.customerId, tenantId: row.tenantId, email: customerRow.email };
    });

    if (!outcome) {
      throw new BadRequestException('invalid or expired reset token');
    }

    // (6) Audit AFTER the commit, FIRE-AND-FORGET (the password change is durably
    //     committed; an audit failure must not 500 a committed credential change —
    //     mirrors C1/). Store a SALTED hash of the email only — never plaintext.
    void this.audit
      .record({
        tenantId: outcome.tenantId,
        actorType: 'customer',
        actorId: outcome.customerId,
        action: 'customer.password_reset',
        resourceType: 'customer',
        resourceId: outcome.customerId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        changes: { emailHash: CustomerResetService.emailAuditHash(outcome.email) },
      })
      .catch((err: unknown) => {
        this.logger.error(
          `customer.password_reset audit write failed (change already committed): ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      });
  }
}
