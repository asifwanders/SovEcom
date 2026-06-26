/**
 * SetupTokenService (SECURITY-CRITICAL).
 *
 * The one-time first-boot setup token that replaces the default-admin-password
 * anti-pattern. It is a 32-byte (256-bit) cryptographically-random value,
 * base64url-encoded. Only its SHA-256 hash is persisted (NOT Argon2id: a 256-bit
 * random token has no brute-force surface, so Argon2id's deliberate slowness buys
 * nothing and would break consistency with the reset-token precedent in
 * `auth/services/reset.service.ts`). The plaintext is
 * returned ONCE from {@link generateToken} (the boot banner is its only consumer)
 * and is NEVER stored, logged, or returned anywhere else.
 *
 *   generateToken()         — mint a fresh token, persist its hash + 24h expiry,
 *                             return the PLAINTEXT (caller must not log it).
 *   supersedeUnusedTokens() — expire any prior unused/unexpired tokens so only the
 *                             latest banner token is live (boot regeneration).
 *   verifyToken(token)      — validate-only lookup (SHA-256, unexpired, unused).
 *                             Does NOT consume. Returns `{ valid, expiresAt }`.
 * consumeToken(token) — ATOMIC single-use claim. Exactly one
 *                             concurrent caller wins; the rest get `false`.
 */
import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service';
import { setupTokens } from '../database/schema/setup_tokens';

/** 256-bit token (matches the reset-token entropy in reset.service.ts). */
const TOKEN_BYTES = 32;
/** 24h time-to-live. */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface VerifyResult {
  valid: boolean;
  /** ISO-8601 expiry when valid; `null` otherwise. */
  expiresAt: string | null;
}

@Injectable()
export class SetupTokenService {
  constructor(private readonly database: DatabaseService) {}

  /** SHA-256 hex of the token (opaque high-entropy convention). */
  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Mint a new setup token: 32 random bytes → base64url plaintext, persist its
   * SHA-256 hash with a 24h `expires_at`, and return the PLAINTEXT exactly once.
   * The caller (the boot banner) is the ONLY place the plaintext may surface.
   */
  async generateToken(): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    await this.database.db.insert(setupTokens).values({
      tokenHash: SetupTokenService.hash(token),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    });
    return token;
  }

  /**
   * Expire every prior unused, unexpired token (set `expires_at = now()`), so a
   * fresh boot's token is the only live one. Idempotent; safe to call before
   * each {@link generateToken} on a not-installed boot.
   */
  async supersedeUnusedTokens(): Promise<void> {
    await this.database.db
      .update(setupTokens)
      .set({ expiresAt: sql`now()` })
      .where(and(isNull(setupTokens.usedAt), gt(setupTokens.expiresAt, sql`now()`)));
  }

  /**
   * Validate-only: is `token` a live (unexpired, unused) setup token? Returns its
   * expiry when valid. Does NOT consume — verify-token is idempotent and must not
   * burn the single use. A non-string / empty token is invalid.
   */
  async verifyToken(token: string): Promise<VerifyResult> {
    if (typeof token !== 'string' || token.length === 0) {
      return { valid: false, expiresAt: null };
    }
    const hash = SetupTokenService.hash(token);
    const [row] = await this.database.db
      .select({ expiresAt: setupTokens.expiresAt })
      .from(setupTokens)
      .where(
        and(
          eq(setupTokens.tokenHash, hash),
          isNull(setupTokens.usedAt),
          gt(setupTokens.expiresAt, sql`now()`),
        ),
      )
      .limit(1);

    if (!row) {
      return { valid: false, expiresAt: null };
    }
    return { valid: true, expiresAt: row.expiresAt.toISOString() };
  }

  /**
   * ATOMIC single-use consume. One `UPDATE... WHERE used_at IS NULL
   * AND expires_at > now() RETURNING id` — Postgres serialises the row write, so
   * under N concurrent callers EXACTLY ONE gets a row (→ `true`) and the rest get
   * zero rows (→ `false`). No read-then-write TOCTOU gap. 3.2 will call this inside
   * the same transaction that flips `system_state.installed = true`.
   */
  async consumeToken(token: string): Promise<boolean> {
    if (typeof token !== 'string' || token.length === 0) {
      return false;
    }
    const hash = SetupTokenService.hash(token);
    const claimed = await this.database.db
      .update(setupTokens)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(setupTokens.tokenHash, hash),
          isNull(setupTokens.usedAt),
          gt(setupTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: setupTokens.id });

    return claimed.length === 1;
  }

  /** Housekeeping seam: drop already-expired rows. Not on any hot path. */
  async pruneExpired(): Promise<void> {
    await this.database.db.delete(setupTokens).where(lt(setupTokens.expiresAt, sql`now()`));
  }
}
