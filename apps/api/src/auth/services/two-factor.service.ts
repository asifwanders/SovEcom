/**
 * TwoFactorService (SECURITY-CRITICAL).
 *
 * TOTP verification (otplib, ±1 step window) with an ATOMIC matched-counter
 * replay guard. After a code verifies, the absolute matched step is claimed in
 * Redis via `SET key 1 NX EX ttl`; a second presentation of the same code in the
 * same step loses the NX race and is rejected. The secret is read as an
 * AEAD-bound blob (AAD = userId) and decrypted via {@link AeadService}; the
 * service NEVER touches a plaintext secret column directly and fails CLOSED on a
 * null / undecryptable secret.
 *
 * No secret or code is ever logged.
 */
import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import { AeadService } from '../crypto/aead.service';

/** TOTP window: accept the current step ±1 (clock skew tolerance). */
const TOTP_WINDOW = 1;
/** Replay-marker TTL: long enough to cover the accepted window (steps × 30s). */
const REPLAY_TTL_SECONDS = 90;

/** The subset of a user row this service needs. */
export interface TotpUser {
  id: string;
  /** AEAD-encrypted TOTP secret blob, or null when 2FA is not enrolled. */
  totpSecret: string | null;
}

/**
 * Minimal Redis surface: an `SET key val NX EX ttl`-style call returning the
 * ioredis result (`'OK'` when the key was set, `null` when it already existed).
 */
interface RedisLike {
  set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null>;
}

/** AEAD surface used to decrypt the stored secret (bound to the userId). */
interface AeadLike {
  decrypt(blob: string, aad: string): string;
}

@Injectable()
export class TwoFactorService {
  constructor(
    private readonly redis: RedisLike,
    private readonly aead: AeadLike | AeadService,
  ) {}

  /**
   * Verify `code` for `user`. Returns true only if the code is valid within the
   * window AND has not been used before (replay guard wins atomically). Fails
   * closed (false) on a null or undecryptable secret. Never throws.
   */
  async verify(user: TotpUser, code: string): Promise<boolean> {
    if (!user.totpSecret) {
      return false; // fail closed: no secret => no second factor
    }

    let secret: string;
    try {
      secret = this.aead.decrypt(user.totpSecret, user.id);
    } catch {
      return false; // fail closed: tampered / wrong-AAD / undecryptable
    }

    const check = authenticator.check(code, secret, TOTP_WINDOW);
    if (!check.valid || check.matchedStep === null) {
      return false;
    }

    // Atomic single-use claim of the matched step (replay guard).
    return this.claimUsedCode(user.id, check.matchedStep);
  }

  /**
   * Atomically CLAIM a verified TOTP step for `userId` so the code that produced it
   * is single-use (replay guard). Returns true if the claim succeeded (first use),
   * false if the step was already claimed (replay). Shared by {@link verify} and by
   * the enrollment-confirm path — which verifies against the PENDING secret
   * directly but MUST still burn the accepted code through the same Redis NX claim,
   * so a confirm code cannot be replayed any more than a login code can.
   */
  async claimUsedCode(userId: string, matchedStep: number): Promise<boolean> {
    const key = `auth:totp:${userId}:${matchedStep}`;
    const claimed = await this.redis.set(key, '1', 'EX', REPLAY_TTL_SECONDS, 'NX');
    return claimed === 'OK';
  }
}
