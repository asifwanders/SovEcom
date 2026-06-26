/**
 * notify-back-in-stock — admin-configurable module settings.
 *
 * The manifest declares a `settings.schema` reference; the ACTUAL values are supplied by the admin
 * at install/configure time. Until the runtime threads a typed settings object into `activate(sdk)`
 * (not yet wired — see README "Settings wiring"), the module reads its effective config from
 * this single resolver, which clamps every field to a safe range so a missing/garbage value can
 * never disable the per-run cap, send an unbounded batch, or smuggle a header into the subject.
 *
 * Keeping the parse/clamp here (a pure function) means the handlers and the notify runner share ONE
 * definition of "what the settings mean", and it is unit-testable without any SDK.
 */

/** Effective, validated module settings. */
export interface NotifySettings {
  /** Master on/off. When false the module's endpoints return 404 (feature disabled). */
  readonly enabled: boolean;
  /** Hard cap on emails sent per restock run. Clamped to [1, BATCH_HARD_CAP]. */
  readonly batchSize: number;
  /**
   * Subject template; the literal token `{product}` is replaced with the product title. Bounded
   * length and stripped of control chars so it can never carry a header-injection payload into the
   * email port (the port re-validates the final subject anyway).
   */
  readonly subjectTemplate: string;
}

/** Absolute ceiling on the per-run batch — defends the mail port / rate limiter from an admin typo. */
export const BATCH_HARD_CAP = 5000;
/** Default per-run batch cap when the admin has not set one. */
export const DEFAULT_BATCH_SIZE = 500;
/** Default subject template. `{product}` is substituted with the product title. */
export const DEFAULT_SUBJECT_TEMPLATE = 'Back in stock: {product}';
/** Max length of the subject template. Bounds the stored value. */
export const SUBJECT_TEMPLATE_MAX = 160;

export const DEFAULT_SETTINGS: NotifySettings = {
  enabled: true,
  batchSize: DEFAULT_BATCH_SIZE,
  subjectTemplate: DEFAULT_SUBJECT_TEMPLATE,
};

/** True if `v` is a finite number we can treat as an integer count. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Strip C0/DEL control chars (CR/LF header-injection guard) and bound the length. */
function sanitizeTemplate(v: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = v.replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (stripped.length === 0) return DEFAULT_SUBJECT_TEMPLATE;
  return stripped.length > SUBJECT_TEMPLATE_MAX
    ? stripped.slice(0, SUBJECT_TEMPLATE_MAX)
    : stripped;
}

/**
 * Resolve an untrusted settings bag into effective, clamped {@link NotifySettings}. Unknown keys
 * are ignored; a missing/invalid field falls back to its default. `batchSize` is floored to an
 * integer and clamped to [1, BATCH_HARD_CAP] so the per-run cap can never be disabled (0/∞) or made
 * absurd; `subjectTemplate` is control-char-stripped and length-bounded.
 */
export function resolveSettings(raw: unknown): NotifySettings {
  const bag = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const enabled = typeof bag.enabled === 'boolean' ? bag.enabled : DEFAULT_SETTINGS.enabled;

  let batchSize = DEFAULT_BATCH_SIZE;
  if (isFiniteNumber(bag.batchSize)) {
    batchSize = Math.floor(bag.batchSize);
  }
  if (batchSize < 1) batchSize = 1;
  if (batchSize > BATCH_HARD_CAP) batchSize = BATCH_HARD_CAP;

  const subjectTemplate =
    typeof bag.subjectTemplate === 'string'
      ? sanitizeTemplate(bag.subjectTemplate)
      : DEFAULT_SUBJECT_TEMPLATE;

  return { enabled, batchSize, subjectTemplate };
}
