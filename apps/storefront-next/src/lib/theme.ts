/**
 * Storefront theme integration.
 *
 * Fetches `GET /store/v1/theme` server-side via the typed data client and maps the active theme's
 * (opaque) `settings` onto the `globals.css` CSS custom properties. The mapping is intentionally
 * SMALL and DEFENSIVE: `settings` is `Record<string, unknown>` on the wire (opaque), so every value is
 * validated before it touches a CSS var, and anything missing/partial falls back to the default token
 * already declared in `:root`.
 *
 * client-js carries no response types, so `ActiveThemeView` is the storefront's own
 * view-type, kept assignable to `@sovecom/theme-sdk`'s `ActiveTheme` contract.
 */
import { cache } from 'react';
import { parseTemplate, PAGE_TYPES, type PageType, type ThemeTemplate } from '@sovecom/theme-sdk';
import { createStoreClient } from './store-client';
import type { AnalyticsConfig } from '@/components/AnalyticsScripts';

/** The storefront's view of `GET /store/v1/theme` (assignable to theme-sdk `ActiveTheme`). */
export interface ActiveThemeView {
  readonly name: string;
  readonly version: string;
  readonly settings: Readonly<Record<string, unknown>>;
  /**
   * The active theme's wire-delivered page templates. Present only for an active INSTALLED theme that
   * ships templates; absent for the default (bundled) theme or when no theme is active. Every entry here
   * has already passed defensive re-validation so a consumer can treat these as trusted `ThemeTemplate`s.
   */
  readonly templates?: Partial<Record<PageType, ThemeTemplate>>;
  /**
   * Storefront analytics config, piggybacked onto this response by the API (NOT part of the theme itself).
   * Re-validated defensively at fetch — each id is kept only if a bounded plain string.
   */
  readonly analytics?: AnalyticsConfig;
}

/**
 * Defensively coerce the wire `analytics` bag to `AnalyticsConfig`. The API already allowlist-validates
 * these, but they are treated as untrusted at the boundary (defense in depth):
 * each field is kept only when a non-empty, bounded string; anything else → null. Returns undefined
 * when the input is absent / not a plain object so the view's `analytics` stays absent.
 */
export function validateWireAnalytics(raw: unknown): AnalyticsConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const bag = raw as Record<string, unknown>;
  // Re-apply the SAME allowlists the API uses (tenant-settings parseAnalyticsSettings). These ids
  // are interpolated into inline <script> bodies (GA4/Meta) and a script `src`/`data-domain`
  // (Plausible), so the boundary must reject anything that could break out — not just length-bound.
  // Caps match the server's parseAnalyticsSettings (253 for the domain, 32 for the ids) so the
  // boundaries agree and a future reader doesn't mistake this for the effective limit.
  const clean = (v: unknown, allow: RegExp, max: number): string | null =>
    typeof v === 'string' && v.length > 0 && v.length <= max && allow.test(v) ? v : null;
  return {
    plausibleDomain: clean(bag.plausibleDomain, /^[A-Za-z0-9.-]+(,[A-Za-z0-9.-]+)*$/, 253),
    ga4Id: clean(bag.ga4Id, /^[A-Za-z0-9-]+$/, 32),
    metaPixelId: clean(bag.metaPixelId, /^[0-9]+$/, 32),
  };
}

/**
 * Defensively validate the wire `templates` bag. The API validated templates at
 * INSTALL, but at render they are treated as UNTRUSTED (defense in depth): for each page key, the raw
 * value is round-tripped through `parseTemplate(JSON.stringify(value))` and kept ONLY if it (a) parses,
 * AND (b) its `template.page` matches the key it was filed under. Anything invalid / page-mismatched /
 * over-bound is silently DROPPED (never throws) so it falls back to the bundled set. The number of page
 * keys is bounded by {@link PAGE_TYPES}; unknown keys are ignored. Returns `undefined` when the input is
 * absent / not a plain object / yields no valid template, so the view's `templates` is simply absent.
 */
function validateWireTemplates(raw: unknown): Partial<Record<PageType, ThemeTemplate>> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const bag = raw as Record<string, unknown>;
  const out: Partial<Record<PageType, ThemeTemplate>> = {};
  let kept = 0;
  // Iterate the FIXED page-type allowlist (caps the work at PAGE_TYPES regardless of wire-key count).
  for (const page of PAGE_TYPES) {
    const value = bag[page];
    // `== null` covers both an absent key (undefined) AND an explicit `{ home: null }` on the wire.
    if (value == null) continue;
    try {
      const template = parseTemplate(JSON.stringify(value));
      // Keep only when the validated template's own `page` matches the key it arrived under.
      if (template.page === page) {
        out[page] = template;
        kept += 1;
      }
    } catch {
      // A malformed / over-bound / unknown-key wire template is dropped → bundled fallback applies.
    }
  }
  return kept > 0 ? out : undefined;
}

/**
 * The recognised theme-setting keys this storefront maps onto CSS vars. Unknown keys in `settings`
 * are ignored (the contract keeps settings open-ended). Colors are CSS color strings; `radius` is a
 * CSS length. `logoUrl` is consumed by the layout (not a CSS var). Fonts are CSS vars as of 3.9d
 * (`--font-sans`/`--font-heading`), validated by a dedicated font rule (see below).
 */
export interface ThemeCssVars {
  readonly '--background'?: string;
  readonly '--foreground'?: string;
  readonly '--primary'?: string;
  readonly '--primary-hover'?: string;
  readonly '--primary-active'?: string;
  readonly '--primary-foreground'?: string;
  readonly '--accent'?: string;
  readonly '--accent-foreground'?: string;
  readonly '--ring'?: string;
  readonly '--radius'?: string;
  readonly '--font-sans'?: string;
  readonly '--font-heading'?: string;
}

/**
 * settings key → CSS custom property, for values validated by {@link isSafeCssValue} (colors,
 * lengths — short, no commas/quotes). Font-family keys are handled separately (see
 * {@link FONT_SETTING_TO_CSS_VAR}) because a font stack legitimately contains commas, quotes and
 * spaces and can exceed the colour rule's 64-char cap. Only these keys are honoured; all else is
 * ignored.
 */
const SETTING_TO_CSS_VAR: Readonly<Record<string, keyof ThemeCssVars>> = {
  background: '--background',
  foreground: '--foreground',
  primary: '--primary',
  primaryHover: '--primary-hover',
  primaryActive: '--primary-active',
  primaryForeground: '--primary-foreground',
  accent: '--accent',
  accentForeground: '--accent-foreground',
  ring: '--ring',
  radius: '--radius',
};

/**
 * Font-family settings key → CSS custom property (3.9d typography). Values are validated by
 * {@link isSafeFontFamily}, NOT {@link isSafeCssValue}: a font stack is a comma/quote/space-bearing
 * string longer than a colour token, so it needs its own (still defensive) rule. A theme overrides
 * `--font-heading` to e.g. a serif stack; `--font-sans` lets it swap the base stack. Both default in
 * `globals.css` to the existing sans stack, so absence is a visual no-op (default theme unchanged).
 */
const FONT_SETTING_TO_CSS_VAR: Readonly<Record<string, keyof ThemeCssVars>> = {
  fontSans: '--font-sans',
  fontHeading: '--font-heading',
};

/**
 * Reject anything that is not a plain, bounded, non-empty string before it reaches a CSS var, so a
 * malformed `settings` value can never inject markup or break the inline style. We do NOT validate
 * that the string is a *valid* color/length — an invalid CSS value is simply ignored by the browser
 * and the default token shows through, which is the desired graceful fallback.
 */
function isSafeCssValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    // Disallow the few characters that could break out of an inline `style` declaration.
    !/[;{}<>]/.test(value)
  );
}

/**
 * Defensive validator for a CSS `font-family` value. Unlike {@link isSafeCssValue}, this MUST allow
 * the commas, single/double quotes and spaces a real font stack contains (e.g.
 * `Georgia, 'Times New Roman', serif`), and a longer cap (~200) since stacks list several fallbacks.
 * The PRIMARY gate is the allowlist regex: only letters/digits/space/comma/hyphen/period/underscore
 * and quotes may appear, so ANY other character (the `;{}<>()` breakouts, backslash escapes, etc.)
 * is rejected by construction. The explicit `;{}<>()`/backslash/newline and `url(`/`@import` rejects
 * below are DEFENSE-IN-DEPTH, not the boundary — do NOT weaken the allowlist on the assumption the
 * reject-list catches everything (e.g. JS `$` would otherwise let a single trailing `\n` slip past a
 * non-`m` allowlist). A rejected value is simply omitted, so the `globals.css` default stack shows
 * through (graceful fallback) and nothing reaches the inline `style` that could break it.
 */
function isSafeFontFamily(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 200) return false;
  // Reject newlines explicitly: JS `$` (no `m` flag) anchors before a trailing \n, which would
  // otherwise let `"serif\n…"` pass the allowlist below.
  if (/[\n\r]/.test(value)) return false;
  if (/[;{}<>()\\]/.test(value)) return false;
  if (/url\s*\(|@import/i.test(value)) return false;
  // PRIMARY gate — allowlist: font names, generic families, quoted names, and the separators.
  return /^[A-Za-z0-9 ,.\-_'"]+$/.test(value);
}

/**
 * Map a theme's `settings` bag onto the subset of CSS custom properties the storefront overrides.
 * Returns ONLY the vars present and safe in `settings`; absent/invalid ones are omitted so the
 * `globals.css` `:root` defaults apply (graceful fallback). Never throws — a null/partial/garbage
 * theme yields `{}` (full fallback to defaults).
 */
export function themeToCssVars(theme: ActiveThemeView | null | undefined): ThemeCssVars {
  const settings = theme?.settings;
  if (!settings || typeof settings !== 'object') return {};
  const bag = settings as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [settingKey, cssVar] of Object.entries(SETTING_TO_CSS_VAR)) {
    const value = bag[settingKey];
    if (isSafeCssValue(value)) out[cssVar] = value;
  }
  // Font-family keys use the dedicated, still-defensive font validator (commas/quotes/longer cap).
  for (const [settingKey, cssVar] of Object.entries(FONT_SETTING_TO_CSS_VAR)) {
    const value = bag[settingKey];
    if (isSafeFontFamily(value)) out[cssVar] = value;
  }
  return out as ThemeCssVars;
}

/**
 * Extract a safe logo URL from theme settings, or `undefined`. Consumed by the layout header as an
 * `<img src>` — so it is validated as a URL (http(s) absolute or site-root-relative), NOT with the
 * CSS-value rule (whose 64-char cap would reject legitimate CDN logo URLs, and whose concerns —
 * `;{}` — don't apply to an attribute React already escapes). Rejects `javascript:`/`data:`/other
 * schemes; admin-controlled, single-tenant trusted-admin threat model.
 */
export function themeLogoUrl(theme: ActiveThemeView | null | undefined): string | undefined {
  const value = theme?.settings?.['logoUrl'];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return undefined;
  // Allow only http(s) absolute URLs or root-relative paths; reject javascript:/data:/etc.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      new URL(trimmed);
      return trimmed;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  return undefined;
}

/**
 * Fetch the active theme server-side. Returns `null` when no theme is active OR on any transport
 * error — the layout must render with default tokens rather than 500. The
 * theme endpoint is public, so no cookie/auth is forwarded.
 *
 * Wrapped in React `cache` so the layout and Home page share ONE `/store/v1/theme` round-trip per render
 * pass. client-js uses the typed store client (not native `fetch`), so Next's automatic fetch dedup
 * does NOT apply — `cache()` is what restores the single-request performance parity with the old Home.
 * The cache memoises the RESOLVED value, so the null/transport-error fallback is preserved unchanged
 * (a `null` result is cached and returned to both callers).
 */
export const fetchActiveTheme = cache(async (): Promise<ActiveThemeView | null> => {
  try {
    const client = createStoreClient();
    // The wire response carries OPTIONAL `templates` (3.9h-i): `Record<PageType, unknown>` for an active
    // installed theme that ships them; absent otherwise. It is UNKNOWN-shaped at the wire — validated
    // defensively below, never trusted as-is.
    const raw = await client.request<
      '/store/v1/theme',
      'get',
      (ActiveThemeView & { templates?: unknown; analytics?: unknown }) | null
    >('get', '/store/v1/theme');
    if (!raw) return null;

    // Defensively re-validate the wire templates (defense in depth — see {@link validateWireTemplates}).
    // A bad/mismatched template is dropped; a theme with no valid templates yields `undefined`, so the
    // view's `templates` stays absent and every page falls back to the bundled set (default unchanged).
    const templates = validateWireTemplates(raw.templates);
    const analytics = validateWireAnalytics(raw.analytics);
    const view: ActiveThemeView = {
      name: raw.name,
      version: raw.version,
      settings: raw.settings,
      ...(templates ? { templates } : {}),
      ...(analytics ? { analytics } : {}),
    };
    return view;
  } catch {
    // A down/unreachable API (e.g. during `next build` static generation) must not break the
    // layout — fall back to default tokens.
    return null;
  }
});
