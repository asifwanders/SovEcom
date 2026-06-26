/**
 * notify-back-in-stock — subscriber email validation, mirroring the core email PORT's rule.
 *
 * The subscribe endpoint is GUEST-FRIENDLY: the shopper provides their own email, so the email is
 * UNTRUSTED INPUT we will both store and later pass to `sdk.email.send`. The core email port
 * (`module-mail.port.ts`) re-validates the recipient at send time with EXACTLY this rule — reject
 * CR/LF/NUL/comma/semicolon (the header-injection / multi-recipient guard) and require a single
 * syntactically-valid address ≤ EMAIL_TO_MAX chars. We replicate it HERE so a malformed/abusive
 * address is rejected at the boundary (a 400) rather than stored and only failing later at send.
 *
 * Keeping the constants/regex in lockstep with the port is deliberate; the port stays the single
 * source of truth at send time (nothing here can weaken it), and `EMAIL_TO_MAX` is imported from
 * the SDK so the length bound can never drift.
 */
import { EMAIL_TO_MAX } from '@sovecom/module-sdk';

/**
 * Reject any C0 control char (U+0000–U+001F, incl. CR/LF/NUL) plus DEL (U+007F) AND the
 * address-list separators comma/semicolon — the header-injection / multi-recipient guard. This is a
 * strict SUPERSET of the port's `CONTROL_OR_SEPARATOR` (which targets CR/LF/NUL/,/;): we reject the
 * full control-char set so it is uniformly defensible and aligned with `settings.ts`'s
 * `sanitizeTemplate`. A value the port would reject is rejected here too — nothing slips through.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SEPARATOR = /[\x00-\x1f\x7f,;]/;

/**
 * A single syntactically-valid address. Mirrors the port's `SINGLE_EMAIL_RE`: a local part, an `@`,
 * and a dotted domain, none containing whitespace, `@`, list separators, or quoting/bracket chars.
 */
const SINGLE_EMAIL_RE = /^[^\s@,;"'<>()[\]\\]+@[^\s@,;"'<>()[\]\\]+\.[^\s@,;"'<>()[\]\\]+$/;

/**
 * Validate + normalize a subscriber email. Returns the trimmed address when it is a single, valid,
 * injection-safe, bounded-length email; otherwise `undefined` (the handler maps that to 400).
 */
export function validateEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Reject control chars / list separators on the RAW value FIRST — before any trimming, so a
  // trailing CR/LF (a header-injection attempt) can never be silently trimmed into a valid address.
  if (CONTROL_OR_SEPARATOR.test(value)) return undefined;
  // Normalize only surrounding ASCII spaces; an interior space is still rejected by SINGLE_EMAIL_RE.
  const v = value.replace(/^ +| +$/g, '');
  if (v.length === 0 || v.length > EMAIL_TO_MAX) return undefined;
  if (!SINGLE_EMAIL_RE.test(v)) return undefined;
  return v;
}
