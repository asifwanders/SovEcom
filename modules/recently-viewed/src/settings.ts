/**
 * recently-viewed — admin-configurable module settings.
 *
 * The manifest declares a `settings.schema` reference; the ACTUAL values are supplied by the admin
 * at install/configure time and handed to the module. Until the runtime threads a typed settings
 * object into `activate(sdk)` (not yet wired — see README "Settings wiring"), the module reads
 * its effective config from this single resolver, which clamps every field to a safe range so a
 * missing/garbage value can never break the read surface or return an unbounded list.
 *
 * Keeping the parse/clamp here (a pure function) means the handlers share ONE definition of "what
 * the settings mean", and it is unit-testable without any SDK.
 */

/** Effective, validated recently-viewed settings. */
export interface RecentlyViewedSettings {
  /** Master on/off. When false the module's endpoints return 404 (feature disabled). */
  readonly enabled: boolean;
  /** How many items the GET surface returns (newest first). Clamped to [1, MAX_ITEMS_HARD_CAP]. */
  readonly maxItems: number;
  /** Category ids whose products are never surfaced. De-duplicated, bounded, validated strings. */
  readonly excludeCategories: readonly string[];
}

/** Absolute ceiling on `maxItems` — defends the read surface from an admin typo / abuse. */
export const MAX_ITEMS_HARD_CAP = 50;
/** Hard ceiling on how many category ids the exclude list may carry. */
export const MAX_EXCLUDE_CATEGORIES = 100;
/** Default number of items shown when the admin has not set a value. */
export const DEFAULT_MAX_ITEMS = 8;

export const DEFAULT_SETTINGS: RecentlyViewedSettings = {
  enabled: true,
  maxItems: DEFAULT_MAX_ITEMS,
  excludeCategories: [],
};

/** True if `v` is a finite number we can treat as an integer count. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Normalize an untrusted `excludeCategories` value into a bounded, de-duplicated list of non-empty,
 * length-capped category-id strings. A non-array, or any non-string / empty / over-long entry, is
 * dropped (never throws). The list is capped at {@link MAX_EXCLUDE_CATEGORIES}.
 */
function resolveExcludeCategories(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const v = entry.trim();
    if (v.length === 0 || v.length > 64) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_EXCLUDE_CATEGORIES) break;
  }
  return out;
}

/**
 * Resolve an untrusted settings bag into effective, clamped {@link RecentlyViewedSettings}. Unknown
 * keys are ignored; a missing/invalid field falls back to its default. `maxItems` is floored to an
 * integer and clamped to [1, MAX_ITEMS_HARD_CAP]; `excludeCategories` is normalized + bounded.
 */
export function resolveSettings(raw: unknown): RecentlyViewedSettings {
  const bag = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const enabled = typeof bag.enabled === 'boolean' ? bag.enabled : DEFAULT_SETTINGS.enabled;

  let maxItems = DEFAULT_MAX_ITEMS;
  if (isFiniteNumber(bag.maxItems)) maxItems = Math.floor(bag.maxItems);
  if (maxItems < 1) maxItems = 1;
  if (maxItems > MAX_ITEMS_HARD_CAP) maxItems = MAX_ITEMS_HARD_CAP;

  const excludeCategories = resolveExcludeCategories(bag.excludeCategories);

  return { enabled, maxItems, excludeCategories };
}
