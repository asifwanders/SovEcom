/**
 * `@sovecom/theme-sdk` — the public, semver-pinned author-facing contract for the SovEcom theme
 * ecosystem. This package is the SINGLE SOURCE OF TRUTH for the theme manifest: the validator, the
 * types, and the author ergonomics. The core runtime imports these definitions FROM here, so the
 * published SDK can never drift from what the core actually enforces at install time.
 *
 * A theme is a declarative ASSET: there is NO `activate`, NO worker, NO runtime entrypoint, NO
 * capabilities, NO namespaced tables. So this package exports the manifest contract, author-time
 * validation/typing helpers, and the two store-contract types a storefront reads — nothing
 * executable. It is MIT-licensed, distinct from the AGPL core, so it can be vendored by commercial
 * theme authors across the HTTP API boundary.
 *
 * The shared core-API primitives (`CORE_API_VERSION`, `assertCoreCompatible`, `MANIFEST_MAX_BYTES`)
 * are REUSED from `@sovecom/module-sdk` — they have ONE home so both SDKs gate against the same
 * core version.
 */

/** SDK package version (independent of the core API contract version below). */
export const THEME_SDK_VERSION = '1.0.1';

// ── author ergonomics ───────────────────────────────────────────────────────────
export { defineTheme } from './theme.js';
export type { DefineThemeConfig } from './theme.js';
export { defineThemeSlots } from './slots.js';
export { defineThemeSettings } from './settings.js';
export type { ThemeSettings, DocumentedThemeSettings, KnownThemeSettings } from './settings.js';

// ── manifest types + validators (single source of truth) ─────────────────────────
export {
  THEME_NAME_RE,
  SLOT_SLUG_RE,
  TEMPLATE_PATH_RE,
  themeManifestSchema,
  themeTemplateDeclSchema,
  parseAndVerifyThemeManifest,
} from './manifest.js';
export type { ThemeManifest, ThemeTemplateDecl } from './manifest.js';

// ── template contract — section/JSON-template composition ──
// Declarative page templates (`{ page, sections[] }`) + author helpers. PURE validators, no code
// execution; the manifest is UNTOUCHED (the manifest `templates[]` declaration is deferred). Only
// `home` is consumed at this stage; the rest of `PAGE_TYPES` is declared for later stages.
export {
  PAGE_TYPES,
  SECTION_TYPE_RE,
  REGION_NAME_RE,
  MAX_REGION_DEPTH,
  pageTypeSchema,
  regionNameSchema,
  templateSectionSchema,
  templateSchema,
  parseTemplate,
  defineTemplate,
  defineSection,
} from './template.js';
export type { PageType, TemplateSection, ThemeTemplate, SectionDef } from './template.js';

// ── module slot-widget contract (data-descriptor widgets) ────────────────────
// A module contributes storefront UI by returning a typed `{ type, props }` widget descriptor from a
// CLOSED, core-owned MIT vocabulary. PURE validators only — no code/HTML/SVG crosses; the storefront
// renders its own known MIT components. `parseWidget` returns `null` on ANY failure (never throws).
export {
  WIDGET_TYPES,
  WIDGET_MAX_BYTES,
  actionPathSchema,
  actionSchema,
  starRatingSummaryPropsSchema,
  reviewListPropsSchema,
  productCarouselPropsSchema,
  toggleButtonPropsSchema,
  submitFormPropsSchema,
  widgetDescriptorSchema,
  parseWidget,
} from './widget.js';
export type {
  WidgetType,
  WidgetDescriptor,
  StarRatingSummaryProps,
  ReviewListProps,
  ProductCarouselProps,
  ToggleButtonProps,
  SubmitFormProps,
} from './widget.js';

// ── shared core-API primitives (re-exported from @sovecom/module-sdk; ONE home) ───
export { MANIFEST_MAX_BYTES, assertCoreCompatible } from './manifest.js';
export { CORE_API_VERSION } from '@sovecom/module-sdk';

// ── store-contract types ───────────────────────────────────────────────────────
export type { ActiveTheme, SlotBinding, SlotMap } from './store-contract.js';

// ── marketing section settings schemas ────────────────────────────────────────
// Shared, validated contract for hero-banner / cta-banner / promo-tiles / rich-text sections.
// The API, admin editor, and storefront all import from here — one source of truth for validation.
export {
  MARKETING_SECTION_TYPES,
  MARKETING_SECTION_REGISTRY,
  marketingHrefSchema,
  marketingImageUrlSchema,
  heroBannerSettingsSchema,
  ctaBannerSettingsSchema,
  promoTilesSettingsSchema,
  richTextSettingsSchema,
  parseMarketingSectionSettings,
  parseMarketingSection,
} from './marketing-sections.js';
export type {
  MarketingSectionType,
  MarketingSectionDescriptor,
  HeroBannerSettings,
  CtaBannerSettings,
  PromoTilesSettings,
  RichTextSettings,
} from './marketing-sections.js';
