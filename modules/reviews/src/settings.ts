/**
 * reviews — admin-configurable module settings.
 *
 * The manifest declares a `settings.schema` reference; the ACTUAL values are supplied by the admin
 * at install/configure time and handed to the module. Until the runtime threads a typed settings
 * object into `activate(sdk)` (not yet wired — see README "Settings wiring"), the module reads
 * its effective config from this single resolver, which clamps every field to a safe range so a
 * missing/garbage value can never break body validation or silently auto-publish reviews.
 *
 * Keeping the parse/clamp here (a pure function) means the handlers share ONE definition of "what
 * the settings mean", and it is unit-testable without any SDK.
 */

/** Effective, validated reviews settings. */
export interface ReviewsSettings {
  /** Master on/off. When false the module's endpoints return 404 (feature disabled). */
  readonly enabled: boolean;
  /** Minimum body length in code points. Clamped to [0, maxTextLen]. */
  readonly minTextLen: number;
  /** Maximum body length in code points. Clamped to [1, MAX_TEXT_HARD_CAP]. */
  readonly maxTextLen: number;
  /** When true, a new review is stored 'approved' immediately instead of 'pending'. */
  readonly autoApprove: boolean;
}

/** Absolute ceiling on the body length — defends the table from an admin typo / abuse. */
export const MAX_TEXT_HARD_CAP = 5000;
/** Defaults when the admin has not set a value. */
export const DEFAULT_MIN_TEXT_LEN = 10;
export const DEFAULT_MAX_TEXT_LEN = 2000;

export const DEFAULT_SETTINGS: ReviewsSettings = {
  enabled: true,
  minTextLen: DEFAULT_MIN_TEXT_LEN,
  maxTextLen: DEFAULT_MAX_TEXT_LEN,
  autoApprove: false,
};

/** True if `v` is a finite number we can treat as an integer count. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Resolve an untrusted settings bag into effective, clamped {@link ReviewsSettings}. Unknown keys
 * are ignored; a missing/invalid field falls back to its default. `maxTextLen` is floored to an
 * integer and clamped to [1, MAX_TEXT_HARD_CAP]; `minTextLen` is floored, clamped to >= 0 and then
 * to <= the effective `maxTextLen` (so the two bounds can never invert and reject every body).
 */
export function resolveSettings(raw: unknown): ReviewsSettings {
  const bag = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const enabled = typeof bag.enabled === 'boolean' ? bag.enabled : DEFAULT_SETTINGS.enabled;
  const autoApprove =
    typeof bag.autoApprove === 'boolean' ? bag.autoApprove : DEFAULT_SETTINGS.autoApprove;

  let maxTextLen = DEFAULT_MAX_TEXT_LEN;
  if (isFiniteNumber(bag.maxTextLen)) maxTextLen = Math.floor(bag.maxTextLen);
  if (maxTextLen < 1) maxTextLen = 1;
  if (maxTextLen > MAX_TEXT_HARD_CAP) maxTextLen = MAX_TEXT_HARD_CAP;

  let minTextLen = DEFAULT_MIN_TEXT_LEN;
  if (isFiniteNumber(bag.minTextLen)) minTextLen = Math.floor(bag.minTextLen);
  if (minTextLen < 0) minTextLen = 0;
  if (minTextLen > maxTextLen) minTextLen = maxTextLen;

  return { enabled, minTextLen, maxTextLen, autoApprove };
}
