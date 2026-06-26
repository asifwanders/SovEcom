/**
 * Cross-theme SECTION/TEMPLATE CONTRACT — the runnable (vitest) half of the cross-theme
 * coverage. It proves the invariants the section runtime relies on hold for EVERY bundled template of
 * EVERY bundled theme (default + boutique), so a theme can never ship a template the runtime can't
 * render:
 *
 *   1. REGISTRY COVERAGE — every section `type` referenced by every bundled template (recursing into
 *      `regions`) is registered in the appropriate registry: a SERVER page's types in `sectionRegistry`,
 *      the CART page's types in `cartSectionRegistry` (the cart body is a client island). A template
 *      that references an unregistered type FAILS here (the renderer would silently skip it at runtime —
 *      graceful, but a contract bug we want caught at test time, not in production).
 *   2. PARSE — every bundled template round-trips through the SDK `parseTemplate` validator unchanged.
 *   3. RENDER — every SERVER page of every theme renders through the real `renderSections` + real
 *      registry without throwing (catalog seam mocked); every registered CLIENT section is a valid
 *      (synchronous) component. This catches a registered-but-broken section component.
 *   4. THEME COMPLETENESS — both bundled themes resolve a full set of the six page templates.
 *
 * These run LOCALLY (unlike the Playwright cross-theme E2E / visual / PageSpeed scaffolds, which need a
 * booted storefront + API). Mocks: the catalog reads the server loaders call, and the `next-intl/server`
 * `getTranslations` the section components await.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseTemplate, PAGE_TYPES, type TemplateSection, type PageType } from '@sovecom/theme-sdk';

// The server section loaders fetch the catalog; mock the five data-fetching seams so the real
// registry/renderer run end-to-end with deterministic (empty-but-valid) data for every page of every
// theme. Spread the REAL module so every other export (types, slug helpers) survives the mock.
const fetchProducts = vi.fn();
const fetchCategoryTree = vi.fn();
const fetchCategoryBySlug = vi.fn();
const fetchSearch = vi.fn();
const fetchProductBySlug = vi.fn();
vi.mock('@/lib/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/catalog')>()),
  fetchProducts: (...a: unknown[]) => fetchProducts(...a),
  fetchCategoryTree: (...a: unknown[]) => fetchCategoryTree(...a),
  fetchCategoryBySlug: (...a: unknown[]) => fetchCategoryBySlug(...a),
  fetchSearch: (...a: unknown[]) => fetchSearch(...a),
  fetchProductBySlug: (...a: unknown[]) => fetchProductBySlug(...a),
}));

// Section components are async RSCs that await `getTranslations`. Provide an identity translator so
// they render their chrome without a real next-intl server runtime (the contract is "renders without
// throwing", not "renders the right copy" — copy is covered by the per-section/route specs).
vi.mock('next-intl/server', () => ({
  getTranslations: async () => Object.assign((key: string) => key, { rich: (key: string) => key }),
  setRequestLocale: () => undefined,
}));

// The CLIENT cart sections read `useCart()` (which throws outside a <CartProvider>). Mock it with a safe
// empty cart + noop async mutators so the cart template's client sections render in jsdom without a
// provider (the contract is "renders without throwing", not a live cart). `useLocale`/`useTranslations`
// are supplied by `renderWithIntl` (a real NextIntlClientProvider).
const noopAsync = async () => undefined;
vi.mock('@/lib/cart-context', () => ({
  useCart: () => ({
    cart: null,
    itemCount: 0,
    shippingRates: [],
    addItem: noopAsync,
    updateItem: noopAsync,
    removeItem: noopAsync,
    applyDiscount: noopAsync,
    removeDiscount: noopAsync,
    refresh: noopAsync,
    estimateShipping: noopAsync,
    loadShippingRates: noopAsync,
    selectShippingRate: noopAsync,
    setEmail: noopAsync,
    setShippingAddress: noopAsync,
    setBillingAddress: noopAsync,
    associateCustomer: noopAsync,
    recomputeTotals: noopAsync,
  }),
}));

import { renderWithIntl } from '@/test-intl';
import { renderSections } from './renderSections';
import { renderClientSections } from './renderClientSections';
import { sectionRegistry } from './registry';
import { cartSectionRegistry } from './cart-registry';
import {
  TEMPLATE_SETS,
  DEFAULT_THEME_NAME,
  BOUTIQUE_THEME_NAME,
  resolveTemplateSet,
  type TemplateSet,
} from '@/themes';

/** The theme names the storefront ships — both must satisfy the whole contract. */
const BUNDLED_THEME_NAMES = [DEFAULT_THEME_NAME, BOUTIQUE_THEME_NAME] as const;

/** Recursively collect every section `type` a list of template sections references (incl. regions). */
function collectTypes(
  sections: readonly TemplateSection[],
  out: Set<string> = new Set(),
): Set<string> {
  for (const s of sections) {
    out.add(s.type);
    if (s.regions) {
      for (const region of Object.values(s.regions)) collectTypes(region, out);
    }
  }
  return out;
}

beforeEach(() => {
  fetchProducts.mockReset();
  fetchCategoryTree.mockReset();
  fetchCategoryBySlug.mockReset();
  fetchSearch.mockReset();
  fetchProductBySlug.mockReset();
  // Empty-but-valid catalog: the contract is structural ("renders without throwing"), and the empty
  // state is exactly what the CI seed produces, so this mirrors the deployed reality.
  fetchProducts.mockResolvedValue({ products: [], nextCursor: null });
  fetchCategoryTree.mockResolvedValue([]);
  fetchCategoryBySlug.mockResolvedValue(null);
  fetchProductBySlug.mockResolvedValue(null);
  fetchSearch.mockResolvedValue({
    products: [],
    facets: { categories: [], price: null },
    total: 0,
  });
});

describe('section/template contract — both bundled themes (3.9f)', () => {
  it('exposes exactly the two bundled themes, each a full TemplateSet', () => {
    // Length guard (NIT 5a): a theme added to `TEMPLATE_SETS` but not to `BUNDLED_THEME_NAMES` (or vice
    // versa) fails here — so the cross-theme matrix can never silently skip a bundled theme.
    expect(Object.keys(TEMPLATE_SETS)).toHaveLength(BUNDLED_THEME_NAMES.length);
    expect(Object.keys(TEMPLATE_SETS).sort()).toEqual(
      [...BUNDLED_THEME_NAMES].sort((a, b) => a.localeCompare(b)),
    );
  });

  describe.each(BUNDLED_THEME_NAMES)('theme: %s', (themeName) => {
    const set: TemplateSet = resolveTemplateSet(themeName);

    it('provides a template for every one of the six page types', () => {
      for (const page of PAGE_TYPES) {
        expect(set[page], `theme '${themeName}' is missing the '${page}' template`).toBeDefined();
        expect(set[page]!.page).toBe(page);
      }
    });

    it('every bundled template round-trips through parseTemplate unchanged', () => {
      for (const page of PAGE_TYPES) {
        const template = set[page]!;
        expect(() => parseTemplate(JSON.stringify(template))).not.toThrow();
        expect(parseTemplate(JSON.stringify(template))).toEqual(template);
      }
    });

    it('every section type referenced is registered in the appropriate registry', () => {
      for (const page of PAGE_TYPES) {
        const types = collectTypes(set[page]!.sections);
        // The cart body is a client island composed from `cartSectionRegistry`; every other page is
        // server-rendered from `sectionRegistry`. A referenced type missing from its registry would be
        // silently skipped by the renderer at runtime — fail loudly here instead.
        const registry = page === 'cart' ? cartSectionRegistry : sectionRegistry;
        const registryName = page === 'cart' ? 'cartSectionRegistry' : 'sectionRegistry';
        for (const type of types) {
          expect(
            Object.prototype.hasOwnProperty.call(registry, type),
            `theme '${themeName}' page '${page}' references unregistered section '${type}' (expected in ${registryName})`,
          ).toBe(true);
        }
      }
    });

    // The cart page is a client island (no server `renderSections` path); its sections are validated as
    // components below. Every SERVER page renders through the real registry without throwing.
    const serverPages = PAGE_TYPES.filter((p): p is PageType => p !== 'cart');
    it.each(serverPages)(
      'the %s page renders through the real registry without throwing',
      async (page) => {
        // The product + category pages read `ctx.params.slug`; the others ignore it.
        const params = page === 'product' || page === 'category' ? { slug: 'any' } : undefined;
        const nodes = await renderSections({ page, themeName, locale: 'en', params });
        expect(Array.isArray(nodes)).toBe(true);
        // At least one section resolved + rendered (no template silently collapsed to empty).
        expect(nodes.length).toBeGreaterThan(0);
      },
    );

    // S1: the CART page is a CLIENT island — render its template's client sections through the real
    // `renderClientSections` + `cartSectionRegistry` (with `useCart` mocked to an empty cart), wrapped in
    // a real intl provider. Mirrors the server-page render check: closes the "registered but throws on
    // render" gap for the cart sections, on BOTH themes.
    it('the cart page client sections render without throwing', () => {
      const cartTemplate = set.cart!;
      const nodes = renderClientSections({ template: cartTemplate, registry: cartSectionRegistry });
      expect(nodes.length).toBeGreaterThan(0);
      // Actually mount them — a section that throws on render surfaces here (the act of rendering is the
      // assertion). `renderWithIntl` supplies the `useLocale`/`useTranslations('cart')` client context.
      expect(() => renderWithIntl(<>{nodes}</>, 'en')).not.toThrow();
    });
  });
});

describe('registry integrity (3.9f)', () => {
  it('every server section is keyed by its own type and exposes a Component', () => {
    for (const [key, section] of Object.entries(sectionRegistry)) {
      expect(section.type).toBe(key);
      expect(typeof section.Component).toBe('function');
    }
  });

  it('every client (cart) section is keyed by its own type and is a synchronous component', () => {
    for (const [key, section] of Object.entries(cartSectionRegistry)) {
      expect(section.type).toBe(key);
      expect(typeof section.Component).toBe('function');
      // A client section's Component must NOT be an async function (the renderer renders it un-awaited;
      // an async one would render `[object Promise]`). `AsyncFunction` has that constructor name.
      expect(section.Component.constructor.name).not.toBe('AsyncFunction');
    }
  });
});
