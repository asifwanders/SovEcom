/**
 * OPTIONAL settings-schema typing helper(s).
 *
 * A theme MAY ship a `settingsSchema` path pointing at a JSON-schema file describing the shape of
 * its tunable settings. That path stays OPAQUE: the core never reads or executes
 * the referenced file at validation time. These helpers are therefore purely COMPILE-TIME
 * ergonomics — they let an author type the settings object their theme expects, with NO runtime
 * behaviour, NO file read, NO code execution. The author's settings shape is their own; the SDK
 * only gives it a name.
 */

/**
 * The settings shape a theme's `settingsSchema` describes — an arbitrary author-defined record.
 * This is the same loose shape the store contract surfaces as {@link ActiveTheme.settings}.
 * Authors may narrow it with their own interface (see {@link defineThemeSettings}).
 */
export type ThemeSettings = Record<string, unknown>;

/**
 * The design-token settings keys the MIT storefront RECOGNISES and maps onto CSS custom properties.
 * Documenting them here gives theme authors editor autocomplete for the supported knobs
 * WITHOUT closing the contract — {@link KnownThemeSettings} intersects this with the open-ended
 * record so arbitrary author keys still type-check. No runtime behaviour: these are pure
 * compile-time ergonomics (the SDK keeps `settings` opaque to the core).
 *
 * Typography values are CSS `font-family` STACKS (e.g. `Georgia, 'Times New Roman', serif`).
 * Per the project's RGPD rule the storefront ships SYSTEM stacks only — no webfont files / Google
 * Fonts / CDN — so these need no asset and are safe by construction.
 */
export interface DocumentedThemeSettings {
  /** CSS color string for the page background (→ `--background`). */
  readonly background?: string;
  /** CSS color string for the body text (→ `--foreground`). */
  readonly foreground?: string;
  /** Brand/primary color (→ `--primary`). */
  readonly primary?: string;
  /** Primary hover color (→ `--primary-hover`). */
  readonly primaryHover?: string;
  /** Primary active/pressed color (→ `--primary-active`). */
  readonly primaryActive?: string;
  /** Text/icon color on a primary surface (→ `--primary-foreground`). */
  readonly primaryForeground?: string;
  /** Accent color (→ `--accent`). */
  readonly accent?: string;
  /** Text/icon color on an accent surface (→ `--accent-foreground`). */
  readonly accentForeground?: string;
  /** Focus ring color (→ `--ring`). */
  readonly ring?: string;
  /** CSS length for the corner radius scale (→ `--radius`). */
  readonly radius?: string;
  /** Base sans font-family stack (→ `--font-sans`). System stack — no webfont (RGPD). */
  readonly fontSans?: string;
  /**
   * Heading font-family stack (→ `--font-heading`); override to a serif stack.
   * System stack — no webfont (RGPD).
   */
  readonly fontHeading?: string;
  /** Absolute http(s) or root-relative logo URL (consumed by the layout, not a CSS var). */
  readonly logoUrl?: string;
  /**
   * Bounded HEADER LAYOUT chrome variant. NOT a CSS var — the storefront reads it to choose
   * between the simple flat nav (`simple`, default) and a multi-column mega-menu (`mega`). An unknown
   * value falls back to `simple`, so the default theme is unchanged.
   */
  readonly 'header.layout'?: 'simple' | 'mega';
  /**
   * Bounded CART AFFORDANCE chrome variant. NOT a CSS var — the storefront reads it to choose
   * between opening the in-page drawer (`drawer`, default) and a plain link to `/cart` (`page-link`). An
   * unknown value falls back to `drawer`, so the default theme is unchanged.
   */
  readonly 'cart.affordance'?: 'drawer' | 'page-link';
}

/**
 * The settings shape with the {@link DocumentedThemeSettings} keys typed for autocomplete while
 * staying open-ended for arbitrary author knobs. Use as the type argument to
 * {@link defineThemeSettings} (e.g. `defineThemeSettings<KnownThemeSettings>({ … })`).
 */
export type KnownThemeSettings = DocumentedThemeSettings & ThemeSettings;

/**
 * Identity helper that simply types-and-returns an author's default settings object. Gives the
 * author editor autocomplete + a single inferred `T` to reuse, while remaining a pure no-op at
 * runtime (it returns its argument unchanged). It does NOT read or validate against the
 * `settingsSchema` file — that path stays opaque.
 */
export function defineThemeSettings<T extends ThemeSettings>(defaults: T): T {
  return defaults;
}
