/**
 * `otplib` compatibility shim (SECURITY-CRITICAL).
 *
 * otplib v13 ships a *functional* API (`generateSecret`, `generateSync`,
 * `verifySync`, …) and dropped the v12 `authenticator` singleton. Our test
 * fixtures and the integration harness were authored against the familiar
 * `authenticator.generateSecret()` / `authenticator.generate(secret)` surface,
 * and TOTP secret generation must be IDENTICAL between the code that mints a
 * secret and the code that verifies it. To keep a single source of truth we
 * expose a thin v12-shaped `authenticator` object built ON TOP OF the real
 * otplib v13 sync functions — no reimplementation of the TOTP math.
 *
 * Both `tsconfig.json` (paths) and the two Jest configs (moduleNameMapper)
 * alias the bare specifier `otplib` to this file, so every `import { authenticator }
 * from 'otplib'` in this app resolves here and shares one TOTP engine.
 *
 * This file contains NO secrets and logs NOTHING.
 */
// The real otplib v13 functional API. The CJS build is loaded via its package
// export under the test/runtime CommonJS resolver; types come from the package.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import * as otplib from 'otplib/functional';

/** otplib v13 TOTP defaults: SHA-1, 6 digits, 30-second step. */
const STEP_SECONDS = 30;

interface VerifyResult {
  valid: boolean;
  /** Step offset of the matched window (e.g. -1, 0, +1); undefined when invalid. */
  delta?: number;
  /** Absolute TOTP counter of the token's own time slice; undefined when invalid. */
  timeStep?: number;
}

interface OtplibV13Functional {
  generateSecret(options?: { size?: number }): string;
  generateSync(options: { secret: string; epoch?: number }): string;
  verifySync(options: {
    token: string;
    secret: string;
    /** ± skew tolerance in SECONDS (NOT a step count — see `check`). */
    epochTolerance?: number;
  }): VerifyResult;
}

const fn = otplib as unknown as OtplibV13Functional;

/**
 * Result of a windowed TOTP verification, including the *absolute* matched step
 * so callers can implement an atomic per-step replay guard.
 */
export interface TotpCheck {
  valid: boolean;
  /** Absolute matched counter (`floor(epoch/step) + delta`); null when invalid. */
  matchedStep: number | null;
}

/**
 * v12-compatible `authenticator` facade over otplib v13's functional core.
 * Adds `check(...)` which surfaces the absolute matched step for replay guards.
 */
export const authenticator = {
  /** Generate a fresh base32 TOTP secret. */
  generateSecret(): string {
    return fn.generateSecret();
  },

  /**
   * Synchronously generate the 6-digit code for `secret`. With no `epoch` this is
   * the CURRENT code; pass an `epoch` (seconds) to generate the code for another
   * time-step (used by tests to obtain a *fresh* code in the next window, since a
   * TOTP code is single-use across the replay guard).
   */
  generate(secret: string, epoch?: number): string {
    return epoch === undefined ? fn.generateSync({ secret }) : fn.generateSync({ secret, epoch });
  },

  /**
   * Verify `token` against `secret` within ±`window` steps. Returns the absolute
   * matched step (for replay defence) or null when the token is invalid.
   */
  check(token: string, secret: string, window = 1): TotpCheck {
    // otplib v13's `verifySync` accepts `epochTolerance` in SECONDS, NOT a step
    // `window`. Passing `{ window }` is silently ignored, leaving epochTolerance=0
    // (only the EXACT current step verifies — no clock-skew tolerance at all).
    // Translate the intended ±`window` STEPS into seconds so a code from an
    // adjacent step (legitimate clock skew, or a deliberately fresh next-step code)
    // is accepted, while the matched step is still surfaced for the replay guard.
    const res = fn.verifySync({
      token,
      secret,
      epochTolerance: window * STEP_SECONDS,
    });
    if (!res.valid || res.timeStep === undefined) {
      return { valid: false, matchedStep: null };
    }
    // otplib v13 `verifySync` returns `timeStep` = the ABSOLUTE counter of the
    // matched token (`t`) and `delta` = `t - currentStep`. The replay guard keys
    // on the matched token's own step, which is invariant for a given code across
    // its whole ±window validity. That is exactly `timeStep`; do NOT add `delta`
    // (= `2t - currentStep`), which drifts as wall-clock crosses a step boundary
    // and would let the same code be replayed one step later under a new key.
    return { valid: true, matchedStep: res.timeStep };
  },

  /** The TOTP step in seconds (30s). */
  get step(): number {
    return STEP_SECONDS;
  },
} as const;
