/**
 * Bundled template-sets — the storefront ships a `default` set of page
 * templates so the runtime always has something to render even with no installed theme. A template-set
 * maps a page type → its template; `resolveTemplateSet(name)` picks the set for the active theme name,
 * falling back to `default` for an unknown or absent name (a theme that ships no template for a page
 * is handled upstream by the renderer, which falls back to the `default` set's page template).
 *
 * Each bundled JSON template is run through `@sovecom/theme-sdk`'s `parseTemplate` at module load: a
 * malformed bundled template fails fast at build/boot rather than silently mis-rendering, and the
 * imported wide JSON type is narrowed to the validated `ThemeTemplate`.
 */
import { parseTemplate, type ThemeTemplate, type PageType } from '@sovecom/theme-sdk';
import defaultHomeJson from './default/templates/home.json';
import defaultProductJson from './default/templates/product.json';
import defaultCartJson from './default/templates/cart.json';
import defaultCategoryJson from './default/templates/category.json';
import defaultSearchJson from './default/templates/search.json';
import defaultProductsJson from './default/templates/products.json';
import boutiqueHomeJson from './boutique/templates/home.json';
import boutiqueProductJson from './boutique/templates/product.json';
import boutiqueCartJson from './boutique/templates/cart.json';
import boutiqueCategoryJson from './boutique/templates/category.json';
import boutiqueSearchJson from './boutique/templates/search.json';
import boutiqueProductsJson from './boutique/templates/products.json';
import { boutiqueDefaultSettings } from './boutique/settings';

/** A template-set: the page templates a theme provides, keyed by page type. */
export type TemplateSet = Partial<Record<PageType, ThemeTemplate>>;

/**
 * The per-theme settings bag a bundled theme ships as its defaults: design tokens and bounded chrome
 * flags. Layered under any live API settings in the layout, so the API can override any bundled default.
 */
export type ThemeSettingsBag = Readonly<Record<string, unknown>>;

/**
 * A bundled theme — its page templates plus its bundled default settings. The default theme ships
 * empty defaults, so it stays unchanged; boutique ships its editorial token and chrome-flag defaults.
 */
export interface BundledTheme {
  readonly templates: TemplateSet;
  readonly defaultSettings: ThemeSettingsBag;
}

/** Validate a bundled JSON template at module load (fail fast on a malformed bundled asset). */
function bundled(json: unknown): ThemeTemplate {
  return parseTemplate(JSON.stringify(json));
}

/** The fallback theme name used when a theme name is unknown/absent. */
export const DEFAULT_THEME_NAME = 'default';

/** The Boutique theme name — the second bundled theme. */
export const BOUTIQUE_THEME_NAME = 'boutique';

/**
 * The `default` template-set — the always-present baseline. Home + PDP + Cart (through 3.9b) plus the
 * category / search / products PLPs (3.9c — the `columns` layout primitive + sectionized listings).
 */
const defaultSet: TemplateSet = {
  home: bundled(defaultHomeJson),
  product: bundled(defaultProductJson),
  cart: bundled(defaultCartJson),
  category: bundled(defaultCategoryJson),
  search: bundled(defaultSearchJson),
  products: bundled(defaultProductsJson),
};

/**
 * The `boutique` template-set — the same section library rearranged for an editorial identity: a
 * full-bleed home hero, a story-driven PDP (all-images grid gallery on top, info below), and
 * functional-but-styled PLPs and cart (the serif, warm palette, mega-nav, and page-link cart
 * differentiate it; see `./boutique/settings`).
 */
const boutiqueSet: TemplateSet = {
  home: bundled(boutiqueHomeJson),
  product: bundled(boutiqueProductJson),
  cart: bundled(boutiqueCartJson),
  category: bundled(boutiqueCategoryJson),
  search: bundled(boutiqueSearchJson),
  products: bundled(boutiqueProductsJson),
};

/**
 * Bundled themes keyed by theme name. Each carries its page templates and bundled default settings.
 * `default` ships empty defaults, so it is unchanged; `boutique` ships its editorial token and
 * chrome-flag defaults.
 */
export const BUNDLED_THEMES: Readonly<Record<string, BundledTheme>> = {
  [DEFAULT_THEME_NAME]: { templates: defaultSet, defaultSettings: {} },
  [BOUTIQUE_THEME_NAME]: { templates: boutiqueSet, defaultSettings: boutiqueDefaultSettings },
};

/**
 * Bundled template-sets keyed by theme name (kept as a derived view for back-compat with the section
 * renderer, which only needs templates). Mirrors {@link BUNDLED_THEMES} one-to-one.
 */
export const TEMPLATE_SETS: Readonly<Record<string, TemplateSet>> = Object.fromEntries(
  Object.entries(BUNDLED_THEMES).map(([name, theme]) => [name, theme.templates]),
);

/**
 * Resolve the template-set for a theme name, falling back to the `default` set for an unknown or
 * absent name. Never returns undefined — the `default` set is always present.
 */
export function resolveTemplateSet(name?: string): TemplateSet {
  if (name && Object.prototype.hasOwnProperty.call(TEMPLATE_SETS, name)) {
    return TEMPLATE_SETS[name]!;
  }
  return TEMPLATE_SETS[DEFAULT_THEME_NAME]!;
}

/**
 * Resolve the bundled default settings for a theme name. An unknown or absent name falls back to the
 * `default` theme's defaults (which are empty). The layout layers these under the live API settings
 * so the API can override any bundled default.
 */
export function bundledDefaultSettings(name?: string): ThemeSettingsBag {
  if (name && Object.prototype.hasOwnProperty.call(BUNDLED_THEMES, name)) {
    return BUNDLED_THEMES[name]!.defaultSettings;
  }
  return BUNDLED_THEMES[DEFAULT_THEME_NAME]!.defaultSettings;
}

// `resolveActiveThemeName` (the server-runtime `STOREFRONT_THEME` reader) lives in the server-only
// `./active-theme` module, not here, so the client `CartPageView`, which imports `resolveTemplateSet`
// from this file, can never pull the server-env reader into the browser bundle.
