/**
 * reviews — untrusted-input validation for the review body + rating.
 *
 * The body is free text a shopper types: it is UNTRUSTED and stored, so it is validated at the
 * boundary. We reject C0 control characters (U+0000–U+001F) and DEL (U+007F) EXCEPT the three
 * whitespace controls a multi-line review legitimately needs — TAB (U+0009), LF (U+000A) and
 * CR (U+000D). Everything else (NUL, bell, escape, …) is rejected so a stored body can never carry a
 * terminal-escape / injection payload. Length is measured in Unicode CODE POINTS (`[...s].length`),
 * not UTF-16 units, so an emoji counts as one character against the configured bounds.
 *
 * The rating must be an INTEGER in [1,5]; a float (4.5), out-of-range (0/6), or non-number is
 * rejected. The DB has a matching CHECK constraint as defense-in-depth.
 */

/**
 * Disallowed control characters: the full C0 range + DEL, MINUS the whitespace controls TAB/LF/CR
 * that a review body may legitimately contain. Written with hex escapes only — no raw control bytes
 * ever appear in source.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

/** True if `s` contains any forbidden control character. */
export function hasForbiddenControlChar(s: string): boolean {
  return FORBIDDEN_CONTROL.test(s);
}

/** The result of validating a candidate rating. */
export type RatingResult = { ok: true; rating: number } | { ok: false };

/** Validate a rating: must be an integer in [1,5]. */
export function validateRating(value: unknown): RatingResult {
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false };
  if (value < 1 || value > 5) return { ok: false };
  return { ok: true, rating: value };
}

/** Why a body was rejected (the handler maps each to a stable error code). */
export type BodyError =
  | 'invalid_body'
  | 'body_has_control_chars'
  | 'body_too_short'
  | 'body_too_long';

/** The result of validating a candidate body. */
export type BodyResult = { ok: true; body: string } | { ok: false; error: BodyError };

/**
 * Validate + normalize a review body against the configured length bounds (in code points).
 * Trailing/leading whitespace is trimmed BEFORE the length check; control chars are rejected on the
 * trimmed value. Returns the trimmed body on success, or a specific error code on failure.
 */
export function validateBody(value: unknown, minLen: number, maxLen: number): BodyResult {
  if (typeof value !== 'string') return { ok: false, error: 'invalid_body' };
  const body = value.trim();
  if (hasForbiddenControlChar(body)) return { ok: false, error: 'body_has_control_chars' };
  const codePoints = [...body].length;
  if (codePoints < minLen) return { ok: false, error: 'body_too_short' };
  if (codePoints > maxLen) return { ok: false, error: 'body_too_long' };
  return { ok: true, body };
}
