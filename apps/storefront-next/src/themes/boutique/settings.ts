/**
 * Boutique theme — bundled default settings.
 *
 * Boutique is the second bundled storefront theme: a dramatically different EDITORIAL identity composed
 * from the SAME section library via different JSON templates (`./templates/*.json`) + these token / chrome
 * defaults. There is NO theme-authored code — only design tokens, bounded chrome-variant ENUMs, and
 * section-setting flags. These defaults are layered UNDER any live API theme settings in the layout
 * (`{ ...bundledDefaultSettings('boutique'), ...(apiSettings ?? {}) }`), so an admin can still override
 * any token via the `/store/v1/theme` settings bag.
 *
 * Two kinds of keys live here:
 *   - DESIGN TOKENS (`background`/`foreground`/`primary`/…/`fontHeading`) consumed by `themeToCssVars`
 *     and mapped onto the `globals.css` CSS custom properties — exactly the recognised keys the default
 *     theme would honour, just given editorial values. `fontHeading` is a SYSTEM serif stack (no webfont
 *     — RGPD), so it needs no asset.
 *   - CHROME FLAGS (`header.layout`, `cart.affordance`) — NOT CSS vars. They are read separately by the
 *     layout (see `@/lib/chrome-variants`) and passed as props to the client chrome, like `logoUrl`.
 *
 * Palette: warm editorial — ivory background, deep warm-brown text, terracotta/sienna primary, muted
 * gold accent. All pairings verified ≥ WCAG-AA contrast (text ≥ 4.5:1).
 */
import type { KnownThemeSettings } from '@sovecom/theme-sdk';

/**
 * The bundled Boutique settings. Typed as the documented-keys-plus-open-record shape so the recognised
 * token keys autocomplete while the chrome-flag keys (`header.layout`/`cart.affordance`) — which are NOT
 * documented CSS-var keys — still type-check via the open-ended record arm.
 */
export const boutiqueDefaultSettings: KnownThemeSettings = {
  // ── design tokens → CSS vars (via themeToCssVars) ──────────────────────────────────────────────
  background: '#faf7f2',
  foreground: '#2b2622',
  primary: '#7c3a2d',
  primaryHover: '#6a3026',
  primaryActive: '#56261e',
  primaryForeground: '#faf7f2',
  accent: '#8a6d1f',
  accentForeground: '#ffffff',
  ring: '#7c3a2d',
  // System serif stack — no webfont / CDN (RGPD). Drives `--font-heading` (all headings → serif).
  fontHeading: "Georgia, 'Times New Roman', 'Times', serif",

  // ── bounded chrome flags (NOT CSS vars — read by the layout, passed to client chrome) ──────────
  'header.layout': 'mega',
  'cart.affordance': 'page-link',
};
