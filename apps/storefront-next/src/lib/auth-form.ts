/**
 * Pure helpers for the auth forms. No React, no I/O — unit-testable in isolation.
 * AUTH-CRITICAL: the redirect sanitiser is an open-redirect guard, and the register error mapper
 * encodes the partial-state handling for signup-then-login flows.
 */
import { SovEcomApiError } from '@sovecom/client-js';

/** The API enforces a 12-char minimum (SignupSchema). Mirror it client-side for a fast, clear error. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Lightweight email shape check (NOT an RFC validator — the server is authoritative). Just enough to
 * catch obvious typos before a round-trip: one `@`, a non-empty local part, a dotted domain, no spaces.
 */
export function isValidEmail(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > 320) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * Open-redirect guard for a post-login `returnTo`. Returns a SAFE internal path or `null`:
 *   - must be a string starting with a single `/` (root-relative);
 *   - rejects `//host` and `/\host` (protocol-relative → external);
 *   - rejects any control char or raw space, and any `:` (no scheme/userinfo sneaking in).
 * The locale-aware router prefixes the active locale, so we return a locale-LESS path (e.g. `/account`).
 */
export function safeReturnTo(returnTo: string | undefined | null): string | null {
  if (typeof returnTo !== 'string' || returnTo.length === 0) return null;
  if (returnTo[0] !== '/') return null; // must be root-relative
  if (returnTo.startsWith('//') || returnTo.startsWith('/\\')) return null; // protocol-relative
  // Reject any control char (<= 0x20, incl. space) — iterate char codes (no literal control-char regex).
  for (let i = 0; i < returnTo.length; i += 1) {
    if (returnTo.charCodeAt(i) <= 0x20) return null;
  }
  if (returnTo.includes(':')) return null; // no scheme/userinfo sneaking in
  return returnTo;
}

/**
 * The outcome the register form must render after `register()` (signup-then-login) rejects. The auth
 * context throws a SINGLE error from either the signup OR the auto-login call; we disambiguate by the
 * API's distinct status codes:
 *   - 409 (signup ConflictException) → duplicate active email → tell them to sign in.
 *   - 400 (signup BadRequestException 'password is too common') → weak password.
 *   - 401 (login UnauthorizedException) → signup SUCCEEDED but the auto-login failed → "account
 *     created — please sign in", routed to login.
 *   - anything else → generic retry.
 */
export type RegisterFailure =
  | 'duplicate'
  | 'weak-password'
  | 'account-created-sign-in'
  | 'unexpected';

export function classifyRegisterError(err: unknown): RegisterFailure {
  if (err instanceof SovEcomApiError) {
    if (err.status === 409) return 'duplicate';
    if (err.status === 400) return 'weak-password';
    // A 401 cannot come from signup (it's @Public, no auth) — it can only be the auto-login leg, so
    // the account was created but the session mint failed. Surface the partial-state hint, not a
    // generic "registration failed".
    if (err.status === 401) return 'account-created-sign-in';
  }
  return 'unexpected';
}
