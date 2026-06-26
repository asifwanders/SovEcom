/**
 * PasswordService (SECURITY-CRITICAL).
 *
 * Argon2id password hashing with the pinned cost parameters. Verification is
 * constant-time (delegated to `argon2.verify`). `dummyVerify` runs a REAL Argon2
 * verification against a precomputed decoy hash so the unknown-user login branch
 * spends the same time as a real verify — the anti-enumeration / timing defence.
 *
 * The password is NEVER logged.
 */
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/** Pinned Argon2id parameters (TR-AUTH-001). ~200ms on the target runner. */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
};

@Injectable()
export class PasswordService {
  /**
   * A decoy `$argon2id$` hash with the SAME params as live hashes, lazily
   * computed once. `dummyVerify` runs against it so the missing-user path does
   * genuine Argon2 work (constant-time enumeration defence).
   */
  private decoyHash: Promise<string> | null = null;

  /** Hash a password with Argon2id. Output carries the `$argon2id$` prefix. */
  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  /**
   * Verify `password` against an Argon2 `digest`. Constant-time; returns false
   * (never throws) on mismatch or malformed digest.
   */
  async verify(digest: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(digest, password);
    } catch {
      return false;
    }
  }

  /**
   * Run a real Argon2id verification against a fixed decoy hash. Used on the
   * unknown-user login branch to match the timing of a genuine verify. Always
   * resolves (never throws), never reveals which branch ran.
   */
  async dummyVerify(password: string): Promise<void> {
    if (this.decoyHash === null) {
      // Hash a fixed, non-secret decoy with the live params, exactly once.
      this.decoyHash = argon2.hash('sovecom-dummy-verify-decoy', ARGON2_OPTIONS);
    }
    try {
      const decoy = await this.decoyHash;
      await argon2.verify(decoy, password);
    } catch {
      // Swallow: the result/branch must never be observable.
    }
  }
}
