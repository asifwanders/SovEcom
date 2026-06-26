import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseTemplate } from '@sovecom/theme-sdk';
import {
  resolveTemplateSet,
  TEMPLATE_SETS,
  BUNDLED_THEMES,
  DEFAULT_THEME_NAME,
  BOUTIQUE_THEME_NAME,
  bundledDefaultSettings,
  type TemplateSet,
} from './index';
// `resolveActiveThemeName` moved to the server-only `./active-theme` module (3.9f, N1).
import { resolveActiveThemeName } from './active-theme';

/** Shared active-theme-name resolver (env > API name > default). */
describe('resolveActiveThemeName', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses the API theme name when no env override is set', () => {
    expect(resolveActiveThemeName({ name: 'boutique' })).toBe('boutique');
    expect(resolveActiveThemeName({ name: 'default' })).toBe('default');
  });

  it('falls back to default for a null / nameless / empty-name API theme', () => {
    expect(resolveActiveThemeName(null)).toBe('default');
    expect(resolveActiveThemeName(undefined)).toBe('default');
    expect(resolveActiveThemeName({})).toBe('default');
    // Empty / whitespace API name falls through (|| not ??) → default (Sonnet N2).
    expect(resolveActiveThemeName({ name: '' })).toBe('default');
    expect(resolveActiveThemeName({ name: '   ' })).toBe('default');
  });

  it('the env override TAKES PRECEDENCE over the API name (the deliberate dev/E2E override)', () => {
    vi.stubEnv('STOREFRONT_THEME', 'boutique');
    expect(resolveActiveThemeName({ name: 'default' })).toBe('boutique');
    expect(resolveActiveThemeName(null)).toBe('boutique');
  });

  it('an empty / whitespace env override falls through to the API name (|| not ??)', () => {
    vi.stubEnv('STOREFRONT_THEME', '   ');
    expect(resolveActiveThemeName({ name: 'boutique' })).toBe('boutique');
    expect(resolveActiveThemeName(null)).toBe('default');
  });
});

/** Bundled template-sets resolve correctly and every template is valid. */
describe('resolveTemplateSet', () => {
  it("resolves the 'default' set by name", () => {
    expect(resolveTemplateSet('default')).toBe(TEMPLATE_SETS[DEFAULT_THEME_NAME]);
  });

  it('falls back to the default set for an unknown name', () => {
    expect(resolveTemplateSet('does-not-exist')).toBe(TEMPLATE_SETS[DEFAULT_THEME_NAME]);
  });

  it('falls back to the default set for an absent name', () => {
    expect(resolveTemplateSet()).toBe(TEMPLATE_SETS[DEFAULT_THEME_NAME]);
    expect(resolveTemplateSet(undefined)).toBe(TEMPLATE_SETS[DEFAULT_THEME_NAME]);
  });

  it('the default set provides a home template', () => {
    const set = resolveTemplateSet('default');
    expect(set.home).toBeDefined();
    expect(set.home!.page).toBe('home');
    expect(set.home!.sections.map((s) => s.type)).toEqual([
      'hero',
      'featured-products',
      'category-list',
    ]);
  });

  it('the default set provides a product template (breadcrumbs + columns regions — 3.9e-i)', () => {
    const set = resolveTemplateSet('default');
    expect(set.product).toBeDefined();
    expect(set.product!.page).toBe('product');
    // Pin the section types so a wrong type name in product.json fails HERE, not only via integration.
    expect(set.product!.sections.map((s) => s.type)).toEqual(['breadcrumbs', 'columns']);
    const columns = set.product!.sections[1]!;
    // The PDP columns emits the verbatim 2-col grid: bare left gallery + a `space-y-6` right cell (so
    // product-info + variant-selector share the single right cell, parity with the pre-refactor PDP).
    expect(columns.settings).toMatchObject({
      containerClass: 'grid grid-cols-1 md:grid-cols-2 gap-8',
      rightClass: 'space-y-6',
    });
    expect(columns.regions!.left!.map((s) => s.type)).toEqual(['product-gallery']);
    expect(columns.regions!.right!.map((s) => s.type)).toEqual([
      'product-info',
      'variant-selector',
    ]);
  });

  it('the default set provides a cart template (columns regions — 3.9e-i)', () => {
    const set = resolveTemplateSet('default');
    expect(set.cart).toBeDefined();
    expect(set.cart!.page).toBe('cart');
    // Pin the section type so a wrong type name in cart.json fails HERE, not only via integration.
    expect(set.cart!.sections.map((s) => s.type)).toEqual(['columns']);
    const columns = set.cart!.sections[0]!;
    // The cart columns emits the verbatim 2-col grid: left wrapped in flex-col gap-6, summary bare.
    expect(columns.settings).toMatchObject({
      containerClass: 'grid gap-8 lg:grid-cols-[1fr_20rem]',
      leftClass: 'flex flex-col gap-6',
      rightClass: '',
    });
    expect(columns.regions!.left!.map((s) => s.type)).toEqual([
      'cart-line-items',
      'cart-discount',
      'cart-shipping',
    ]);
    expect(columns.regions!.right!.map((s) => s.type)).toEqual(['cart-summary']);
  });

  it('the default set provides a category template (header-row + columns regions — 3.9c)', () => {
    const set = resolveTemplateSet('default');
    expect(set.category).toBeDefined();
    expect(set.category!.page).toBe('category');
    expect(set.category!.sections.map((s) => s.type)).toEqual(['category-header-row', 'columns']);
    const columns = set.category!.sections[1]!;
    expect(columns.regions!.left!.map((s) => s.type)).toEqual(['category-filter-sidebar']);
    expect(columns.regions!.right!.map((s) => s.type)).toEqual(['category-results']);
  });

  it('the default set provides a search template (columns regions — 3.9c)', () => {
    const set = resolveTemplateSet('default');
    expect(set.search).toBeDefined();
    expect(set.search!.page).toBe('search');
    expect(set.search!.sections.map((s) => s.type)).toEqual(['columns']);
    const columns = set.search!.sections[0]!;
    expect(columns.regions!.left!.map((s) => s.type)).toEqual(['search-filter-sidebar']);
    expect(columns.regions!.right!.map((s) => s.type)).toEqual([
      'search-results-header',
      'search-product-grid',
      'search-pagination',
    ]);
  });

  it('the default set provides a FLAT products template (no columns — 3.9c)', () => {
    const set = resolveTemplateSet('default');
    expect(set.products).toBeDefined();
    expect(set.products!.page).toBe('products');
    expect(set.products!.sections.map((s) => s.type)).toEqual([
      'products-header',
      'product-grid',
      'products-load-more',
    ]);
    // Flat: no section declares regions.
    expect(set.products!.sections.every((s) => s.regions === undefined)).toBe(true);
  });
});

/** Boutique theme: a second bundled template-set plus its bundled default settings. */
describe('boutique theme', () => {
  it("resolves the 'boutique' template-set by name", () => {
    expect(resolveTemplateSet(BOUTIQUE_THEME_NAME)).toBe(TEMPLATE_SETS[BOUTIQUE_THEME_NAME]);
    expect(resolveTemplateSet(BOUTIQUE_THEME_NAME)).not.toBe(TEMPLATE_SETS[DEFAULT_THEME_NAME]);
  });

  it('provides all six page templates, each on the right page', () => {
    const set = resolveTemplateSet(BOUTIQUE_THEME_NAME);
    expect(set.home!.page).toBe('home');
    expect(set.product!.page).toBe('product');
    expect(set.cart!.page).toBe('cart');
    expect(set.category!.page).toBe('category');
    expect(set.search!.page).toBe('search');
    expect(set.products!.page).toBe('products');
  });

  it('home is editorial: a full-bleed hero opt-in (default home is NOT full-bleed)', () => {
    const boutiqueHome = resolveTemplateSet(BOUTIQUE_THEME_NAME).home!;
    expect(boutiqueHome.sections.map((s) => s.type)).toEqual([
      'hero',
      'featured-products',
      'category-list',
    ]);
    expect(boutiqueHome.sections[0]!.settings).toMatchObject({ fullBleed: true });
    // The DEFAULT home hero carries no fullBleed setting (so it stays the rounded card).
    const defaultHome = resolveTemplateSet(DEFAULT_THEME_NAME).home!;
    expect(defaultHome.sections[0]!.settings).toBeUndefined();
  });

  it('product is story-driven: the gallery uses the all-images grid layout', () => {
    const product = resolveTemplateSet(BOUTIQUE_THEME_NAME).product!;
    const columns = product.sections.find((s) => s.type === 'columns')!;
    const gallery = columns.regions!.left!.find((s) => s.type === 'product-gallery')!;
    expect(gallery.settings).toMatchObject({ layout: 'grid' });
    // The DEFAULT product gallery carries no layout setting (so it stays the carousel).
    const defaultProduct = resolveTemplateSet(DEFAULT_THEME_NAME).product!;
    const defaultGallery = defaultProduct.sections
      .find((s) => s.type === 'columns')!
      .regions!.left!.find((s) => s.type === 'product-gallery')!;
    expect(defaultGallery.settings).toBeUndefined();
  });

  it('boutique templates reference only REGISTERED section types', () => {
    // The set of section types the boutique templates use must be a subset of the default set's types
    // (no boutique template introduces an unregistered section — composition only, no new code).
    const collect = (set: TemplateSet): Set<string> => {
      const out = new Set<string>();
      const walk = (sections: { type: string; regions?: Record<string, unknown[]> }[]) => {
        for (const s of sections) {
          out.add(s.type);
          if (s.regions) {
            for (const region of Object.values(s.regions)) {
              walk(region as { type: string; regions?: Record<string, unknown[]> }[]);
            }
          }
        }
      };
      for (const tpl of Object.values(set)) walk(tpl!.sections);
      return out;
    };
    const defaultTypes = collect(resolveTemplateSet(DEFAULT_THEME_NAME));
    const boutiqueTypes = collect(resolveTemplateSet(BOUTIQUE_THEME_NAME));
    for (const type of boutiqueTypes) expect(defaultTypes.has(type)).toBe(true);
  });
});

/** Per-theme bundled default settings and API-overrides-bundled merge. */
describe('bundledDefaultSettings', () => {
  it('the default theme ships EMPTY defaults (so it is unchanged)', () => {
    expect(bundledDefaultSettings(DEFAULT_THEME_NAME)).toEqual({});
    expect(BUNDLED_THEMES[DEFAULT_THEME_NAME]!.defaultSettings).toEqual({});
  });

  it('an unknown / absent name falls back to the (empty) default defaults', () => {
    expect(bundledDefaultSettings('does-not-exist')).toEqual({});
    expect(bundledDefaultSettings()).toEqual({});
    expect(bundledDefaultSettings(undefined)).toEqual({});
  });

  it('boutique ships editorial token + chrome-flag defaults', () => {
    const s = bundledDefaultSettings(BOUTIQUE_THEME_NAME);
    expect(s.fontHeading).toMatch(/serif/i);
    expect(s.background).toBeTypeOf('string');
    expect(s.primary).toBeTypeOf('string');
    expect(s['header.layout']).toBe('mega');
    expect(s['cart.affordance']).toBe('page-link');
  });

  it('merge order: API settings override the bundled defaults', () => {
    // Simulate the layout merge `{ ...bundled, ...api }`.
    const bundled = bundledDefaultSettings(BOUTIQUE_THEME_NAME);
    const api = { primary: '#000000', 'header.layout': 'simple' };
    const effective: Record<string, unknown> = { ...bundled, ...api };
    expect(effective.primary).toBe('#000000'); // API wins
    expect(effective['header.layout']).toBe('simple'); // API wins
    expect(effective['cart.affordance']).toBe('page-link'); // bundled default preserved
  });
});

describe('every bundled template passes parseTemplate', () => {
  it('re-validates each template in each bundled set', () => {
    const sets = Object.values(TEMPLATE_SETS) as TemplateSet[];
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      for (const template of Object.values(set)) {
        // A bundled template must round-trip through the SDK validator unchanged.
        expect(() => parseTemplate(JSON.stringify(template))).not.toThrow();
        expect(parseTemplate(JSON.stringify(template))).toEqual(template);
      }
    }
  });
});
