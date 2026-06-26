/**
 *C3 — CustomerEmailService (AUTH/CREDENTIAL/PII-CRITICAL).
 *
 * The authenticated customer's self-service CHANGE-EMAIL flow, VERIFY-BEFORE-SWITCH:
 * the customer proves their CURRENT password at INITIATE, a single-use token is
 * emailed to the NEW address, and clicking the link CONFIRMS the swap. The live
 * `customers.email` is never switched until the new address is verified, so a typo or
 * an attacker who briefly holds a session cannot lock the owner out of their account.
 *
 * It composes the SAME primitives as C1 (change-password) — no new crypto, no new
 * session mechanics:
 *
 *   INITIATE — `requestEmailChange`:
 *     - step-up (C1.requireStepUp template): rate-limit 5/60s fail-closed keyed
 *       `customer-change-email:${ip}:${customerId}`, load the active customer, verify
 *       the CURRENT password with argon2id, `dummyVerify` on the throttle / missing-
 *       hash branches. A uniform 401 on every failure path (never a password oracle).
 *     - no-op guard: newEmail === current (case-insensitive) → 400 (only reachable
 *       AFTER the password is verified, so it leaks nothing).
 *     - NO account-existence oracle: the `customers_tenant_email_active_uq` partial
 *       index is the real uniqueness guard. If the target is ALREADY an active
 *       customer's email in this tenant we return the SAME 202 as the happy path but
 *       send NO mail and stash NO token (silent no-op) — so INITIATE is a uniform 202
 *       regardless of whether the target is taken.
 *     - free path (one tx): consume any prior unconsumed token for this customer (only
 *       the newest link works), insert a new SHA-256 token (1h TTL, pending_email),
 *       and set `customers.pending_email`. Then fire-and-forget the verify email to the
 *       NEW address.
 *
 *   CONFIRM — `confirmEmailChange` (PUBLIC, the token IS the credential):
 *     - rate-limit `email-change-confirm:${ip}` 10/60s fail-closed → uniform 429
 *       (mirrors ResetService.reset).
 *     - atomic single-use consume (ResetService.reset template): cheap pre-check by
 *       hash, then an `UPDATE … SET consumed_at = now() WHERE (unconsumed, unexpired)
 *       RETURNING …` — the conditional UPDATE is the single-use lock.
 *     - in the SAME tx, swap `email = pendingEmail`, clear `pending_email`, checking
 *       the swap rowcount (a concurrent erase → 400, rolling back the consume too).
 *       The swap can violate the partial-unique index if someone took the address
 *       between initiate+confirm → that aborts the tx (rolling back the consume), so
 *       we burn the token best-effort OUTSIDE the tx and surface a clean 409 (a retry
 *       just re-hits the 409 — the swap can't succeed while the target stays taken).
 *     - does NOT bump token_version, revoke refresh families, mint tokens, or set
 *       cookies — the CustomerAuthGuard re-reads the email from the DB each request,
 *       so the session transparently sees the new email (no email claim in the JWT).
 *
 * The token plaintext is only emailed + (NODE_ENV=test only) mirrored to Redis via the
 * EMAIL_CHANGE_TOKEN_SINK seam; only its SHA-256 hash is persisted. Audit rows store a
 * SALTED hash of the email, never plaintext.
 */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { RedisService } from '../../redis/redis.service';
import { customers } from '../../database/schema/customers';
import { emailChangeTokens } from '../../database/schema/email_change_tokens';
import { AuditService } from '../../audit/audit.service';
import { PasswordService } from '../../auth/services/password.service';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { MAIL_SERVICE, type IMailService } from '../../mail/mail.service';
import { resolveEmailLocale } from '../../emails/i18n/email-locale';
import { isUniqueViolation } from '../../common/pg-error.util';

/** Step-up rate-limit budget at INITIATE (per ip+customer) — mirrors C1. */
const STEPUP_LIMIT = 5;
const STEPUP_WINDOW_SECONDS = 60;
/** Per-IP throttle at the PUBLIC confirm endpoint — mirrors ResetService.reset. */
const CONFIRM_IP_LIMIT = 10;
const CONFIRM_IP_WINDOW_SECONDS = 60;
const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class CustomerEmailService {
  private readonly logger = new Logger(CustomerEmailService.name);

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

  /** Salted hash of an email for audit rows (never plaintext, 022.8 — mirrors). */
  private static emailAuditHash(email: string): string {
    const salt = CustomerEmailService.auditEmailSalt();
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
   * Build the storefront confirm link from server config ONLY (never a request Host
   * header). Mirrors ResetService.buildResetUrl but points at the storefront
   * (`STORE_ORIGIN`, comma-separated — the SAME env the customer refresh CSRF
   * allowlist uses; first entry wins). The URL carries a single-use token (never
   * logged): `${origin}/${locale}/account/email-confirm?token=…`.
   */
  private static buildVerifyUrl(token: string, locale: string): string {
    const base = process.env.STORE_ORIGIN ?? 'http://localhost:3000';
    const origin = base.split(',')[0]?.trim() || 'http://localhost:3000';
    const root = origin.replace(/\/$/, '');
    return `${root}/${locale}/account/email-confirm?token=${encodeURIComponent(token)}`;
  }

  /**
   * INITIATE an email change. Verifies `currentPassword` (step-up), then — only when
   * the target is free in this tenant — stashes a single-use token, sets
   * `customers.pending_email`, and emails the verify link to the NEW address. Returns
   * void (the controller answers 202).
   *
   * On the FREE path it ALSO emails a `requested` SECURITY NOTICE to the customer's
   * CURRENT address so the legitimate owner is alerted to an in-flight
   * change even if an attacker who briefly held the session initiated it.
   *
   * Failure modes:
   *   - throttled / missing-customer / no-password / wrong-password → uniform 401;
   *   - newEmail === current (case-insensitive) → 400;
   *   - newEmail already taken by another active customer → silent no-op (still 202).
   */
  async requestEmailChange(
    tenantId: string,
    customerId: string,
    newEmail: string,
    currentPassword: string,
    ctx: RequestContext,
  ): Promise<void> {
    // (1) Step-up: rate-limit (fail-closed) → load active customer → verify password.
    const customer = await this.requireStepUp(tenantId, customerId, currentPassword, ctx);

    // (2) No-op guard. Only reachable AFTER the password was verified, so the 400
    //     leaks nothing an attacker who already knows the password doesn't know.
    if (newEmail.toLowerCase() === customer.email.toLowerCase()) {
      throw new BadRequestException('new email must differ from the current email');
    }

    // (3) Anti-enumeration: if the target is ALREADY an active customer's email in
    //     this tenant, do NOT reveal it. Return the SAME 202 as the happy path but
    //     stash NO token + send NO mail (silent no-op). The partial-unique index is
    //     the real guard; this keeps INITIATE a uniform 202 (no account-existence
    //     oracle). A confirm-time race is still caught at the swap (→ 409).
    const [taken] = await this.database.db
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.tenantId, tenantId),
          sql`lower(${customers.email}) = ${newEmail.toLowerCase()}`,
          isNull(customers.deletedAt),
          isNull(customers.anonymizedAt),
        ),
      )
      .limit(1);
    if (taken) {
      // Uniform 202 — do not distinguish "taken" from "free" to the caller. To keep
      // the AWAITED DB work shape-equal with the free path (F4: no timing oracle), do
      // a no-op transaction of matching shape (two WHERE-false UPDATEs that touch no
      // rows) before returning. The residual delta (tx statement CONTENT, not row
      // work) is small and the oracle is bounded behind auth + the correct password +
      // the 5/60s step-up gate, so this is defence-in-depth, not the primary control.
      await this.database.db.transaction(async (tx) => {
        await tx
          .update(emailChangeTokens)
          .set({ consumedAt: sql`now()` })
          .where(sql`false`);
        await tx
          .update(customers)
          .set({ updatedAt: sql`now()` })
          .where(sql`false`);
      });
      return;
    }

    // (4) Free path: mint a token (only the hash is persisted) and stash it + the
    //     pending mirror in ONE tx, invalidating any prior unconsumed token first so
    //     only the NEWEST link works.
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const tokenHash = CustomerEmailService.hashToken(token);

    await this.database.db.transaction(async (tx) => {
      // Invalidate prior unconsumed tokens for this customer (newest-link-only).
      await tx
        .update(emailChangeTokens)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(emailChangeTokens.customerId, customerId),
            eq(emailChangeTokens.tenantId, tenantId),
            isNull(emailChangeTokens.consumedAt),
          ),
        );

      await tx.insert(emailChangeTokens).values({
        tenantId,
        customerId,
        tokenHash,
        pendingEmail: newEmail,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      });

      // UI mirror of the in-flight change (authoritative state is the token row).
      await tx
        .update(customers)
        .set({ pendingEmail: newEmail, updatedAt: sql`now()` })
        .where(
          and(
            eq(customers.id, customerId),
            eq(customers.tenantId, tenantId),
            isNull(customers.deletedAt),
            isNull(customers.anonymizedAt),
          ),
        );
    });

    // (5) Test-only seam (mirrors RESET_TOKEN_SINK): mirror the plaintext token to
    //     Redis so integration tests can drive /confirm. HARD-gated on NODE_ENV=test.
    if (process.env.NODE_ENV === 'test' && process.env.EMAIL_CHANGE_TOKEN_SINK === '1') {
      await this.redis.client.set(
        `test:last-email-change-token:${customerId}`,
        token,
        'EX',
        Math.floor(TOKEN_TTL_MS / 1000),
      );
    }

    // (6) Send mail (locale from the customer's stored preference). BOTH are
    //     fire-and-forget: the token is already committed, so a mail hiccup must not
    //     500 a committed change (mirrors ResetService). Two messages:
    //       - the VERIFY link to the NEW address (clicking it confirms the swap); and
    // - a `requested` SECURITY NOTICE to the CURRENT address so
    //         the legitimate owner is alerted to the in-flight change.
    const locale = resolveEmailLocale(customer.locale);
    const verifyUrl = CustomerEmailService.buildVerifyUrl(token, locale);
    void this.mail
      .sendEmailChangeVerification(newEmail, verifyUrl, locale)
      .catch((err: unknown) => {
        this.logger.warn(
          `email-change verification mail dispatch failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      });
    void this.mail
      .sendEmailChangeNotice(customer.email, 'requested', newEmail, locale)
      .catch((err: unknown) => {
        this.logger.warn(
          `email-change requested-notice mail dispatch failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      });

    // (7) Audit AFTER the commit, FIRE-AND-FORGET (F4: keep the awaited path free of
    //     the audit round-trip so it doesn't add a timing delta vs the taken path).
    //     Still post-commit: the change (token + pending mirror) is durably committed,
    //     so an audit failure can't unwind it and must not report failure (mirrors).
    //     Store a SALTED hash of the NEW email — never plaintext.
    void this.audit
      .record({
        tenantId,
        actorType: 'customer',
        actorId: customerId,
        action: 'customer.email_change_requested',
        resourceType: 'customer',
        resourceId: customerId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        changes: { newEmailHash: CustomerEmailService.emailAuditHash(newEmail) },
      })
      .catch((err: unknown) => {
        this.logger.error(
          `customer.email_change_requested audit write failed (change already committed): ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      });
  }

  /**
   * CONFIRM an email change. Consumes the single-use token atomically and swaps the
   * customer's email in the SAME tx. PUBLIC — the token IS the credential. Returns
   * void (the controller answers 200).
   *
   * After the swap commits it emails a `confirmed` SECURITY NOTICE to the OLD address
   * — captured BEFORE the swap overwrites it — so the previous owner is
   * told the change went through and can react if it wasn't them.
   *
   * Failure modes:
   *   - throttled → uniform 429;
   *   - invalid / expired / already-consumed token → 400;
   *   - the customer was erased/deleted concurrently (swap matched no row) → 400
   *     (rolls back the in-tx consume too);
   *   - the target was taken between initiate+confirm (unique violation) → 409, with
   *     the token burned (so it cannot be retried).
   */
  async confirmEmailChange(token: string, ctx: RequestContext): Promise<void> {
    // (1) Per-IP throttle FIRST — public endpoint; fail-closed. Uniform 429 on cap.
    const ipGate = await this.rateLimit.check(`email-change-confirm:${ctx.ip ?? 'unknown'}`, {
      limit: CONFIRM_IP_LIMIT,
      windowSeconds: CONFIRM_IP_WINDOW_SECONDS,
    });
    if (!ipGate.allowed) {
      this.logger.warn('email-change confirm throttled: per-IP cap');
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }

    const hash = CustomerEmailService.hashToken(token);

    // (2) Cheap indexed pre-check (the atomic consume below still re-checks under the
    //     conditional UPDATE, so this does not weaken single-use / TOCTOU).
    const [candidate] = await this.database.db
      .select({ id: emailChangeTokens.id })
      .from(emailChangeTokens)
      .where(
        and(
          eq(emailChangeTokens.tokenHash, hash),
          isNull(emailChangeTokens.consumedAt),
          gt(emailChangeTokens.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    if (!candidate) {
      throw new BadRequestException('invalid or expired token');
    }

    // (3) Atomic single-use consume + swap in ONE tx. Inside the tx we also CAPTURE the
    //     OLD email + locale (before the swap overwrites them) for the post-commit
    //     `confirmed` notice. Two abort paths inside the tx roll back the consume too:
    //       - the swap matches NO row (customer erased/deleted concurrently) → 400; and
    //       - the swap violates the partial-unique index (target taken since initiate)
    //         → the unique-violation aborts the tx; we catch it OUTSIDE and 409.
    let outcome: {
      customerId: string;
      tenantId: string;
      pendingEmail: string;
      oldEmail: string;
      oldLocale: string | null;
    } | null = null;
    try {
      outcome = await this.database.db.transaction(async (tx) => {
        const consumed = await tx
          .update(emailChangeTokens)
          .set({ consumedAt: sql`now()` })
          .where(
            and(
              eq(emailChangeTokens.tokenHash, hash),
              isNull(emailChangeTokens.consumedAt),
              gt(emailChangeTokens.expiresAt, sql`now()`),
            ),
          )
          .returning({
            customerId: emailChangeTokens.customerId,
            tenantId: emailChangeTokens.tenantId,
            pendingEmail: emailChangeTokens.pendingEmail,
          });

        const row = consumed[0];
        if (!row) {
          return null; // raced to consumed / expired between the pre-check and here
        }

        // Capture the OLD email + locale BEFORE the swap (the UPDATE overwrites email).
        // Active-only: an already-erased customer yields no row → the swap below also
        // matches none → 400 (rolls back the consume).
        const [before] = await tx
          .select({ email: customers.email, locale: customers.locale })
          .from(customers)
          .where(
            and(
              eq(customers.id, row.customerId),
              eq(customers.tenantId, row.tenantId),
              isNull(customers.deletedAt),
              isNull(customers.anonymizedAt),
            ),
          )
          .limit(1);

        // Swap email + clear the pending mirror. May violate the partial-unique index
        // if the target was taken since initiate — that error aborts the whole tx (so
        // the consume rolls back too); the catch below burns the token + returns 409.
        // F5: check the rowcount — if the customer was anonymized/deleted concurrently
        // the swap matches no row; throw to roll back the consume (uniform 400).
        const swapped = await tx
          .update(customers)
          .set({ email: row.pendingEmail, pendingEmail: null, updatedAt: sql`now()` })
          .where(
            and(
              eq(customers.id, row.customerId),
              eq(customers.tenantId, row.tenantId),
              isNull(customers.deletedAt),
              isNull(customers.anonymizedAt),
            ),
          )
          .returning({ id: customers.id });

        if (!swapped[0] || !before) {
          // Customer erased/deleted between the consume and the swap. Abort so the
          // conditional consume rolls back (the token stays usable is irrelevant — the
          // account is gone). Surfaced as a uniform 400 below.
          throw new BadRequestException('invalid or expired token');
        }

        return {
          customerId: row.customerId,
          tenantId: row.tenantId,
          pendingEmail: row.pendingEmail,
          oldEmail: before.email,
          oldLocale: before.locale,
        };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // The target was taken between initiate and confirm. The unique-violation
        // aborted the whole tx — which ROLLED BACK the in-tx consume — so the token is
        // live again. Burn it best-effort (outside the tx); if that burn itself fails the
        // link survives, but a retry just re-hits the same 409 (the swap can never succeed
        // while the target stays taken), so it's harmless. Then surface a clean 409.
        await this.consumeTokenBestEffort(hash);
        throw new ConflictException('email address is no longer available');
      }
      throw err;
    }

    if (!outcome) {
      throw new BadRequestException('invalid or expired token');
    }

    // (4) Notify the OLD address that the change went through, using the
    //     email + locale captured BEFORE the swap. Fire-and-forget (post-commit).
    const oldLocale = resolveEmailLocale(outcome.oldLocale);
    void this.mail
      .sendEmailChangeNotice(outcome.oldEmail, 'confirmed', outcome.pendingEmail, oldLocale)
      .catch((err: unknown) => {
        this.logger.warn(
          `email-change confirmed-notice mail dispatch failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      });

    // (5) Audit AFTER the commit, FIRE-AND-FORGET (the swap is durably committed; an
    //     audit failure must not 500 a committed change). Salted hash of the new email.
    void this.audit
      .record({
        tenantId: outcome.tenantId,
        actorType: 'customer',
        actorId: outcome.customerId,
        action: 'customer.email_change_confirmed',
        resourceType: 'customer',
        resourceId: outcome.customerId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        changes: { newEmailHash: CustomerEmailService.emailAuditHash(outcome.pendingEmail) },
      })
      .catch((err: unknown) => {
        this.logger.error(
          `customer.email_change_confirmed audit write failed (change already committed): ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      });
  }

  /**
   * Step-up gate (C1.requireStepUp template): rate-limit (fail-closed) → load the
   * active customer → verify the current password (argon2id). On a missing customer,
   * a customer with no password, or a wrong password, do equal Argon2 work
   * (dummyVerify) and throw a uniform 401 — never a password oracle. Returns the
   * loaded customer row on success.
   */
  private async requireStepUp(
    tenantId: string,
    customerId: string,
    password: string,
    ctx: RequestContext,
  ) {
    const throttle = await this.rateLimit.check(
      `customer-change-email:${ctx.ip ?? 'unknown'}:${customerId}`,
      { limit: STEPUP_LIMIT, windowSeconds: STEPUP_WINDOW_SECONDS },
    );
    if (!throttle.allowed) {
      await this.passwords.dummyVerify(password);
      throw new UnauthorizedException();
    }

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

    if (!customer || !customer.passwordHash) {
      await this.passwords.dummyVerify(password);
      throw new UnauthorizedException();
    }

    const ok = await this.passwords.verify(customer.passwordHash, password);
    if (!ok) {
      throw new UnauthorizedException();
    }
    return customer;
  }

  /** Best-effort consume a token by hash (used after a swap unique-violation rollback). */
  private async consumeTokenBestEffort(hash: string): Promise<void> {
    try {
      await this.database.db
        .update(emailChangeTokens)
        .set({ consumedAt: sql`now()` })
        .where(and(eq(emailChangeTokens.tokenHash, hash), isNull(emailChangeTokens.consumedAt)));
    } catch (err) {
      this.logger.error(
        `failed to consume email-change token after a swap conflict: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }
}
