/**
 * wishlist — admin-configurable module settings.
 *
 * The manifest declares a `settings.schema` reference; the ACTUAL values are supplied by the admin
 * at install/configure time and handed to the module. Until the runtime threads a typed settings
 * object into `activate(sdk)` (not yet wired — see README "Settings wiring"), the module reads
 * its effective config from this single resolver, which clamps every field to a safe range so a
 * missing/garbage value can never disable the per-customer cap or send a malformed digest.
 *
 * Keeping the parse/clamp here (a pure function) means the handlers and the digest builder share
 * ONE definition of "what the settings mean", and it is unit-testable without any SDK.
 */

/** Effective, validated wishlist settings. */
export interface WishlistSettings {
  /** Master on/off. When false the module's endpoints return 404 (feature disabled). */
  readonly enabled: boolean;
  /** Hard cap on wishlist items per customer. Clamped to [1, MAX_ITEMS_HARD_CAP]. */
  readonly maxItemsPerCustomer: number;
  /** Opt-in to the weekly price-drop email digest. */
  readonly weeklyDigest: boolean;
}

/** Absolute ceiling on the per-customer cap — defends the table from an admin typo / abuse. */
export const MAX_ITEMS_HARD_CAP = 1000;
/** Default per-customer cap when the admin has not set one. */
export const DEFAULT_MAX_ITEMS = 100;

export const DEFAULT_SETTINGS: WishlistSettings = {
  enabled: true,
  maxItemsPerCustomer: DEFAULT_MAX_ITEMS,
  weeklyDigest: false,
};

/** True if `v` is a finite number we can treat as an integer count. */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Resolve an untrusted settings bag into effective, clamped {@link WishlistSettings}. Unknown keys
 * are ignored; a missing/invalid field falls back to its default. `maxItemsPerCustomer` is floored
 * to an integer and clamped to [1, MAX_ITEMS_HARD_CAP] so the cap can never be disabled (0/∞) or
 * made absurd.
 */
export function resolveSettings(raw: unknown): WishlistSettings {
  const bag = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const enabled = typeof bag.enabled === 'boolean' ? bag.enabled : DEFAULT_SETTINGS.enabled;
  const weeklyDigest =
    typeof bag.weeklyDigest === 'boolean' ? bag.weeklyDigest : DEFAULT_SETTINGS.weeklyDigest;

  let maxItemsPerCustomer = DEFAULT_MAX_ITEMS;
  if (isFiniteNumber(bag.maxItemsPerCustomer)) {
    maxItemsPerCustomer = Math.floor(bag.maxItemsPerCustomer);
  }
  if (maxItemsPerCustomer < 1) maxItemsPerCustomer = 1;
  if (maxItemsPerCustomer > MAX_ITEMS_HARD_CAP) maxItemsPerCustomer = MAX_ITEMS_HARD_CAP;

  return { enabled, maxItemsPerCustomer, weeklyDigest };
}
