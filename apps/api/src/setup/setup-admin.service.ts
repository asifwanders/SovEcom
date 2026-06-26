/**
 * SetupAdminService (THE MOST SECURITY-CRITICAL service).
 *
 * The email-OTP owner-credential flow that SETS the first real password on the seeded
 * owner SHELL (`admin@default.local`, role `owner`, placeholder hash) — it is
 * an UPDATE, never an INSERT, so no second owner can be minted and no privilege
 * escalation is possible. Two steps:
 *
 *   start({email,name}) — PRECONDITION: a usable mail transport must exist (a persisted
 *     SMTP secret OR env mail). Generate a 6-digit OTP, store ONLY its SHA-256 hash +
 *     a 10-minute expiry in Redis under `setup:admin-otp:<emailLower>`, and send the
 *     plaintext OTP to `email` via a throwaway transport built from the PERSISTED SMTP
 *     secret (reusing SetupConfigService.sendViaSmtpSecret), falling back to the env
 *     MailService when only env mail is configured. Rate-limited per IP + per email.
 *     Returns {sent:true}. The OTP plaintext is NEVER stored, returned, or logged.
 *
 *   verify({email,otp,password}) — rate-limited per-IP AND per-email; validate the OTP
 *     FIRST (SHA-256 constant-time compare, unexpired) — so a caller without a valid OTP
 *     can never probe password strength (no 422-weak vs 401-wrong-OTP oracle) — THEN
 *     breach-check the password (422 if weak, WITHOUT consuming the OTP, so it can be
 *     retried with a stronger one) + Argon2id-hash it (PasswordService), THEN atomically
 *     CONSUME the OTP (the Redis DEL-returns-1 is the AUTHORITATIVE single-use gate, so
 *     two concurrent valid-OTP verifies → exactly one wins), THEN UPDATE the owner row:
 *     set password_hash + (lower-cased) email + name, bump token_version, and mark
 *     `system_state.admin_configured = true` in the tx. A wrong/expired/used OTP — and a
 *     rate-limit — yields a UNIFORM 401/429 that NEVER reveals whether the password was
 *     weak (no oracle; start always reports {sent:true} for a configured transport
 *     regardless of whether the email matches the eventual owner). Returns {ok:true}.
 *     The OTP + password are never logged.
 *
 * SECURITY INVARIANTS: only SHA-256(otp) is stored (expiring, single-use); the password
 * is Argon2id + breach-checked, never logged; the write is an UPDATE on the existing
 * owner shell (one owner, no escalation); every input is bounded by the Zod DTO; the
 * routes are gated by SetupTokenGuard (404 post-install / bad token) + @Public.
 */
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { RedisService } from '../redis/redis.service';
import { users } from '../database/schema/users';
import { systemState } from '../database/schema/system_state';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { PasswordService } from '../auth/services/password.service';
import { isBreachedPassword } from '../auth/services/breached-passwords';
import { MAIL_SERVICE, type IMailService } from '../mail/mail.service';
import { SetupSecretsService } from './setup-secrets.service';
import {
  SetupConfigService,
  type PersistedSmtpCreds,
  type ProbeResult,
} from './setup-config.service';
import type { AdminAccountStartDto, AdminAccountVerifyDto } from './dto/admin-account.dto';

/** OTP time-to-live (10 minutes). */
const OTP_TTL_SECONDS = 10 * 60;
/** Per-IP cap on start (the OTP send path triggers an outbound email). */
const START_IP_LIMIT = 10;
const START_IP_WINDOW_SECONDS = 60 * 60; // 10/hour per IP
/** Per-destination-email cap on start — anti email-bombing one inbox. */
const START_EMAIL_LIMIT = 5;
const START_EMAIL_WINDOW_SECONDS = 60 * 60; // 5/hour per email
/** Per-IP cap on verify — bounds OTP-guessing AND the memory-hard Argon2id hash. */
const VERIFY_IP_LIMIT = 10;
const VERIFY_IP_WINDOW_SECONDS = 60; // 10/minute per IP
/**
 * Per-destination-email cap on verify — bounds total OTP guesses against ONE email
 * across MANY IPs (a distributed attacker cannot get unbounded tries by rotating IPs).
 * Mirrors start's per-email gate; sized to comfortably allow legitimate retries within
 * the 10-minute OTP lifetime while capping a 6-digit (10^6 space) brute force.
 */
const VERIFY_EMAIL_LIMIT = 10;
const VERIFY_EMAIL_WINDOW_SECONDS = 60 * 60; // 10/hour per email

interface RequestContext {
  ip?: string;
}

/**
 * The Redis-stored OTP record: the SHA-256 hash of the OTP (NEVER the plaintext) plus
 * the owner name captured at `start` (the `verify` DTO has no name, so it is carried
 * here). The whole record expires with the 10-minute TTL and is deleted on first use.
 */
interface OtpPayload {
  otpHash: string;
  name: string;
}

@Injectable()
export class SetupAdminService {
  private readonly logger = new Logger(SetupAdminService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly rateLimit: RateLimitService,
    private readonly passwords: PasswordService,
    private readonly secrets: SetupSecretsService,
    private readonly config: SetupConfigService,
    @Inject(MAIL_SERVICE) private readonly mail: IMailService,
  ) {}

  /** SHA-256 hex of the OTP (opaque short-code convention, mirrors reset.service.ts). */
  private static hashOtp(otp: string): string {
    return createHash('sha256').update(otp).digest('hex');
  }

  /** SHA-256 hex of the (lower-cased) email — used as the rate-limit + Redis sub-key. */
  private static emailKey(emailLower: string): string {
    return createHash('sha256').update(emailLower).digest('hex');
  }

  /** Redis key holding the OTP hash for an email (single live OTP per email). */
  private static otpRedisKey(emailLower: string): string {
    return `setup:admin-otp:${SetupAdminService.emailKey(emailLower)}`;
  }

  /**
   * Step 1 — begin the owner-credential set: precondition-check a usable mail
   * transport, mint a 6-digit OTP, store its hash (10-min expiry, single live OTP per
   * email), and send the plaintext via the persisted-SMTP throwaway transport (or env
   * mail). Returns {sent:true} and NEVER the OTP. 422 when no transport is configured.
   */
  async start(
    tenantId: string,
    dto: AdminAccountStartDto,
    ctx: RequestContext,
  ): Promise<{ sent: true }> {
    const emailLower = dto.email.toLowerCase();

    // (a) Rate gates BEFORE any work (per-IP + per-destination-email). Fail-closed.
    await this.throttle(`setup:admin-start:ip:${ctx.ip ?? 'unknown'}`, {
      limit: START_IP_LIMIT,
      windowSeconds: START_IP_WINDOW_SECONDS,
    });
    await this.throttle(`setup:admin-start:email:${SetupAdminService.emailKey(emailLower)}`, {
      limit: START_EMAIL_LIMIT,
      windowSeconds: START_EMAIL_WINDOW_SECONDS,
    });

    // (b) PRECONDITION: a usable mail transport must exist — a persisted SMTP secret
    //     OR env mail. Else 422 (the explicit ordering dependency: SMTP step first).
    const smtpCreds = await this.secrets.getJson<PersistedSmtpCreds>(tenantId, 'smtp');
    const envMail = SetupAdminService.envMailConfigured();
    if (!smtpCreds && !envMail) {
      throw new UnprocessableEntityException('configure SMTP before creating the admin account');
    }

    // (c) Mint a 6-digit OTP (crypto-random, uniform), store ONLY its SHA-256 hash
    //     (alongside the owner NAME captured here, so `verify` — whose DTO has no name —
    //     can set it) with a 10-min TTL. A fresh start overwrites any prior OTP for this
    //     email (SET, not append) so only the latest code is ever valid. The OTP
    //     PLAINTEXT is never stored — only `hash(otp)`.
    const otp = SetupAdminService.generateOtp();
    const payload: OtpPayload = { otpHash: SetupAdminService.hashOtp(otp), name: dto.name };
    await this.redis.client.set(
      SetupAdminService.otpRedisKey(emailLower),
      JSON.stringify(payload),
      'EX',
      OTP_TTL_SECONDS,
    );

    // (d) Send the OTP. Prefer the persisted SMTP secret (throwaway transport, reused
    //     from SetupConfigService); fall back to env MailService. The OTP appears only
    //     in the message body — never in a log line or the response.
    const sent = await this.sendOtp(dto.email, otp, smtpCreds);
    if (!sent.ok) {
      // The transport existed but the send failed. Surface a generic 502 (no OTP, no
      // recipient, no server reply — `sent.error` is already sanitized but we do not
      // even echo that to avoid any send-side oracle). Drop the staged OTP.
      await this.redis.client.del(SetupAdminService.otpRedisKey(emailLower)).catch(() => {});
      this.logger.warn('admin-account OTP send failed (transport configured but send errored)');
      throw new HttpException(
        'could not send the verification email — check the SMTP configuration',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return { sent: true };
  }

  /**
   * Step 2 — verify the OTP and SET the owner credential. Validates the OTP
   * (constant-time compare, unexpired, single-use), breach-checks + Argon2id-hashes the
   * password, then UPDATEs the seeded owner row and marks `admin_configured=true`. A
   * wrong/expired/used OTP throws a uniform 401 (no oracle). Returns {ok:true}.
   */
  async verify(
    tenantId: string,
    dto: AdminAccountVerifyDto,
    ctx: RequestContext,
  ): Promise<{ ok: true }> {
    const emailLower = dto.email.toLowerCase();

    // (1) Throttle FIRST — per-IP AND per-email. The per-IP gate bounds OTP guessing
    //     AND the memory-hard Argon2id hash against an unauthenticated CPU/memory DoS;
    //     the per-email gate bounds the TOTAL guesses against ONE email across MANY IPs
    //     (a distributed attacker can't rotate IPs for unbounded tries). Fail-closed.
    await this.throttle(`setup:admin-verify:ip:${ctx.ip ?? 'unknown'}`, {
      limit: VERIFY_IP_LIMIT,
      windowSeconds: VERIFY_IP_WINDOW_SECONDS,
    });
    await this.throttle(`setup:admin-verify:email:${SetupAdminService.emailKey(emailLower)}`, {
      limit: VERIFY_EMAIL_LIMIT,
      windowSeconds: VERIFY_EMAIL_WINDOW_SECONDS,
    });

    // (2) Validate the OTP BEFORE any password-policy check — so a caller WITHOUT a valid
    //     OTP can never probe password strength (no weak-password 422 oracle vs the
    //     wrong-OTP 401). The Redis value is `{otpHash,name}`; compare the stored hash
    //     (constant-time) against hash(submitted otp). An absent/expired key OR a
    //     mismatch is a UNIFORM 401 — no distinction (no oracle).
    const redisKey = SetupAdminService.otpRedisKey(emailLower);
    const raw = await this.redis.client.get(redisKey).catch(() => null);
    const payload = SetupAdminService.parsePayload(raw);
    const candidateHash = SetupAdminService.hashOtp(dto.otp);
    if (!payload || !SetupAdminService.constantTimeEqualHex(payload.otpHash, candidateHash)) {
      throw new UnauthorizedException('invalid or expired verification code');
    }

    // (3) ONLY NOW — with a proven-valid OTP — run the offline breach-check. This is
    //     reached exclusively by a holder of the correct OTP, so the 422 is not an
    //     oracle. CRITICAL: we have NOT consumed the OTP yet, so a weak-password 422
    //     leaves the SAME OTP usable — the operator can retry it with a stronger
    //     password. (Generic message; the OTP burn happens only past this gate.)
    if (isBreachedPassword(dto.password)) {
      throw new UnprocessableEntityException('password is too weak');
    }

    // (4) Hash the password (Argon2id) BEFORE the single-use DEL so the burn happens as
    //     late as possible (a strong-password verify that crashes mid-hash still leaves
    //     the OTP usable). The OTP is the authoritative single-use token regardless.
    const passwordHash = await this.passwords.hash(dto.password);

    // (5) SINGLE-USE: delete the key NOW (before the write) so a concurrent replay of the
    //     same OTP cannot also pass. `DEL` returns the number of keys removed; if it is 0
    //     a parallel request already consumed this OTP → treat as invalid (uniform 401).
    //     This DEL-returns-1 is the AUTHORITATIVE single-use gate that closes the
    //     replay/TOCTOU window — exactly one of two concurrent valid-OTP verifies wins.
    const removed = await this.redis.client.del(redisKey).catch(() => 0);
    if (removed !== 1) {
      throw new UnauthorizedException('invalid or expired verification code');
    }

    // (6) UPDATE the seeded owner shell. This is an
    //     UPDATE scoped to (tenant, role='owner') — never an INSERT, so no second owner
    //     and no privilege escalation. The email may change from admin@default.local;
    //     it is stored lower-cased. The owner name is the one captured at `start`.
    //     token_version bumps (kills any prior live token).
    const ownerName = payload.name;

    const updated = await this.database.db.transaction(async (tx) => {
      const rows = await tx
        .update(users)
        .set({
          passwordHash,
          email: emailLower,
          name: ownerName,
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(users.tenantId, tenantId), eq(users.role, 'owner')))
        .returning({ id: users.id });

      if (rows.length !== 1) {
        // No (or, defensively, more than one) owner shell — a seed/deployment error.
        return null;
      }

      // Mark admin_configured so /complete can verify the owner password was really set.
      await tx
        .insert(systemState)
        .values({ key: 'admin_configured', value: true })
        .onConflictDoUpdate({
          target: systemState.key,
          set: { value: true, updatedAt: new Date() },
        });

      return rows[0];
    });

    if (!updated) {
      // The owner shell is missing/ambiguous — a deployment error, not a client fault.
      this.logger.error('admin-account verify: owner shell row not found (seed missing?)');
      throw new HttpException('owner account is not provisioned', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    return { ok: true };
  }

  // ─── internals ─────────────────────────────────────────────────────────────────

  /** Generate a uniformly-random 6-digit numeric OTP ("000000"–"999999"). */
  private static generateOtp(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /** Parse the stored Redis OTP record, or null if absent/garbage (treated as no OTP). */
  private static parsePayload(raw: string | null): OtpPayload | null {
    if (!raw) {
      return null;
    }
    try {
      const v = JSON.parse(raw) as unknown;
      if (
        typeof v === 'object' &&
        v !== null &&
        typeof (v as OtpPayload).otpHash === 'string' &&
        typeof (v as OtpPayload).name === 'string'
      ) {
        return v as OtpPayload;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** True when env mail is configured (the same gate MailService uses at boot). */
  private static envMailConfigured(): boolean {
    return Boolean(process.env.BREVO_API_KEY) || Boolean(process.env.SMTP_HOST);
  }

  /**
   * Constant-time compare of two hex digests (both fixed 64-char SHA-256 hex here).
   * Guards against any (marginal) timing signal on the OTP-hash comparison.
   */
  private static constantTimeEqualHex(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) {
      return false;
    }
    return timingSafeEqual(ab, bb);
  }

  /**
   * Send the OTP: a persisted SMTP secret wins (throwaway transport, reused from
   * SetupConfigService), else env MailService. Returns a ProbeResult; the body carries
   * the OTP but is never logged.
   */
  private async sendOtp(
    to: string,
    otp: string,
    smtpCreds: PersistedSmtpCreds | null,
  ): Promise<ProbeResult> {
    const subject = 'SovEcom setup — your verification code';
    const text =
      `Your SovEcom admin-account verification code is: ${otp}\n\n` +
      `It expires in 10 minutes. If you did not start the setup, ignore this email.`;
    const html =
      `<p>Your SovEcom admin-account verification code is:</p>` +
      `<p style="font-size:1.5em;font-weight:bold;letter-spacing:0.2em">${otp}</p>` +
      `<p>It expires in 10 minutes. If you did not start the setup, you can ignore this email.</p>`;

    if (smtpCreds) {
      return this.config.sendViaSmtpSecret(smtpCreds, { to, subject, text, html });
    }
    // Env mail fallback (MailService.send). It returns a message-id result; map any
    // throw to a failed ProbeResult so `start` surfaces a generic send error.
    try {
      await this.mail.send({ to, subject, text, html });
      return { ok: true };
    } catch {
      return { ok: false, error: 'mail send failed' };
    }
  }

  /** Run a rate gate; throws 429 when over budget (fail-closed via RateLimitService). */
  private async throttle(
    key: string,
    opts: { limit: number; windowSeconds: number },
  ): Promise<void> {
    const result = await this.rateLimit.check(key, opts);
    if (!result.allowed) {
      this.logger.warn('admin-account step throttled');
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
