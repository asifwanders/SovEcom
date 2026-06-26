/**
 * TwoFactorEnrollmentService (SECURITY-CRITICAL).
 *
 * The DB-touching half of the 2FA lifecycle (enroll -> confirm -> disable). Kept
 * separate from the pure {@link TwoFactorService} (whose `(redis, aead)` ctor +
 * `verify()` are unit-tested in isolation) so this orchestration can depend on
 * Postgres / Argon2 / AEAD / audit without disturbing that seam.
 *
 *   enroll(user): generate a fresh secret, AEAD-encrypt it (AAD = userId) into
 *     `totp_secret_pending` (inactive until confirmed), and return the plaintext
 *     secret + otpauth URL + QR data-URL exactly once.
 *   confirm(user, code): verify the code against the PENDING secret, then in one
 *     UPDATE move pending -> active and set `totp_enabled = true`.
 *   disable(user, password, code): require BOTH the password AND a fresh TOTP
 *     code; on success clear the secret + flag.
 *
 * The plaintext secret / code are NEVER logged. Fails CLOSED on a missing /
 * undecryptable pending secret.
 */
import { ConflictException, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { toDataURL } from 'qrcode';
import { authenticator } from 'otplib';
import { DatabaseService } from '../../database/database.service';
import { users, type User } from '../../database/schema/users';
import { AuditService } from '../../audit/audit.service';
import { AeadService } from '../crypto/aead.service';
import { PasswordService } from './password.service';
import { TwoFactorService } from './two-factor.service';

const TOTP_ISSUER = 'SovEcom';
const TOTP_WINDOW = 1;
/** Pending-enrollment TTL: a pending secret older than this can't be confirmed. */
const ENROLL_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Returned to the client once, on enroll. The QR encodes the otpauth URL. */
export interface EnrollmentResult {
  secret: string;
  otpauthUrl: string;
  qrDataUrl: string;
}

interface RequestContext {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class TwoFactorEnrollmentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly aead: AeadService,
    private readonly passwords: PasswordService,
    private readonly twoFactor: TwoFactorService,
    private readonly audit: AuditService,
  ) {}

  /** Start enrollment: store an inactive (pending) AEAD secret, return it once. */
  async enroll(user: User, ctx: RequestContext): Promise<EnrollmentResult> {
    // Step-up required to REPLACE an active factor: a bearer of a stolen access
    // token must not be able to silently swap an already-enabled TOTP secret to
    // one it controls. Re-enrollment requires disabling first (disable() demands
    // password + a fresh TOTP code).
    if (user.totpEnabled) {
      throw new ConflictException('2FA is already enabled; disable it before re-enrolling');
    }
    const secret = authenticator.generateSecret();
    const encrypted = this.aead.encrypt(secret, user.id);

    await this.database.db
      .update(users)
      .set({ totpSecretPending: encrypted, totpEnrollStartedAt: new Date() })
      .where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)));

    const otpauthUrl = `otpauth://totp/${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(
      user.email,
    )}?secret=${secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}`;
    const qrDataUrl = await toDataURL(otpauthUrl);

    await this.audit.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.2fa.enroll_started',
      resourceType: 'user',
      resourceId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return { secret, otpauthUrl, qrDataUrl };
  }

  /**
   * Confirm enrollment: verify `code` against the PENDING secret, then activate.
   * Returns false (no state change) on a missing pending secret or a bad code.
   */
  async confirm(user: User, code: string, ctx: RequestContext): Promise<boolean> {
    if (!user.totpSecretPending) {
      return false;
    }
    // enforce the documented enroll TTL: a pending secret with no start
    // timestamp, or one older than ENROLL_TTL_MS, is stale and cannot be activated.
    if (
      !user.totpEnrollStartedAt ||
      Date.now() - user.totpEnrollStartedAt.getTime() > ENROLL_TTL_MS
    ) {
      return false; // fail closed: stale / missing enrollment window
    }
    let secret: string;
    try {
      secret = this.aead.decrypt(user.totpSecretPending, user.id);
    } catch {
      return false; // fail closed
    }

    const check = authenticator.check(code, secret, TOTP_WINDOW);
    if (!check.valid || check.matchedStep === null) {
      return false;
    }

    // burn the accepted code through the SAME atomic Redis NX replay claim
    // every other accepted TOTP code uses, so a confirm code cannot be replayed.
    const claimed = await this.twoFactor.claimUsedCode(user.id, check.matchedStep);
    if (!claimed) {
      return false; // replay: this code was already accepted in this step
    }

    // Move pending -> active and flip the flag in one statement.
    await this.database.db
      .update(users)
      .set({
        totpSecret: user.totpSecretPending,
        totpSecretPending: null,
        totpEnrollStartedAt: null,
        totpEnabled: true,
      })
      .where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)));

    await this.audit.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.2fa.confirm',
      resourceType: 'user',
      resourceId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return true;
  }

  /**
   * Disable 2FA. Requires BOTH the account password AND a fresh TOTP code
   * (a stolen access token alone cannot strip the factor). Returns false (no
   * state change) if either factor fails. The TOTP replay guard runs via the pure
   * {@link TwoFactorService.verify}, so a code that disables 2FA cannot be replayed.
   */
  async disable(user: User, password: string, code: string, ctx: RequestContext): Promise<boolean> {
    const passwordOk = await this.passwords.verify(user.passwordHash, password);
    const codeOk = await this.twoFactor.verify({ id: user.id, totpSecret: user.totpSecret }, code);

    if (!passwordOk || !codeOk) {
      await this.audit.record({
        tenantId: user.tenantId,
        actorType: 'user',
        actorId: user.id,
        action: 'auth.2fa.disable_failed',
        resourceType: 'user',
        resourceId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return false;
    }

    await this.database.db
      .update(users)
      .set({
        totpSecret: null,
        totpSecretPending: null,
        totpEnrollStartedAt: null,
        totpEnabled: false,
      })
      .where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)));

    await this.audit.record({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.id,
      action: 'auth.2fa.disable',
      resourceType: 'user',
      resourceId: user.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return true;
  }
}
