import { describe, it, expect } from 'vitest';
import { defineThemeSettings } from '../src/index.js';
import type { ThemeSettings, KnownThemeSettings } from '../src/index.js';

/**
 * Tests for the pure compile-time settings helper. `defineThemeSettings` is an identity helper
 *: it types-and-returns the author's defaults with NO runtime behaviour, NO file
 * read, NO code execution. These tests pin that no-op contract so the helper is exercised in its
 * own file (it was previously only touched in store-contract.test.ts).
 */
describe('defineThemeSettings', () => {
  it('returns the SAME object reference unchanged (pure identity, no clone)', () => {
    const defaults = { accentColor: '#6c5ce7', showBadges: true, maxItems: 12 };
    const out = defineThemeSettings(defaults);
    expect(out).toBe(defaults);
    expect(out).toEqual({ accentColor: '#6c5ce7', showBadges: true, maxItems: 12 });
  });

  it('preserves nested/empty values without reading or validating any schema', () => {
    expect(defineThemeSettings({})).toEqual({});
    const nested = defineThemeSettings({ theme: { dense: false, palette: ['#000', '#fff'] } });
    expect(nested.theme).toEqual({ dense: false, palette: ['#000', '#fff'] });
  });

  it('infers a reusable T the author can narrow (compile-time ergonomics)', () => {
    // The inferred T is assignable to the loose ThemeSettings the store contract surfaces.
    const defaults = defineThemeSettings({ accentColor: '#000' });
    const asContract: ThemeSettings = defaults;
    expect(asContract.accentColor).toBe('#000');
  });

  it('accepts the documented design-token keys (3.9d typography + extended tokens)', () => {
    // The storefront recognises these keys (theme.ts SETTING_TO_CSS_VAR); the SDK doc-types them
    // via KnownThemeSettings so authors get autocomplete while settings stays open-ended.
    const defaults = defineThemeSettings<KnownThemeSettings>({
      // colors / radius (existing)
      primary: '#00766A',
      radius: '0.5rem',
      // typography (3.9d) — system font-family stacks, RGPD-clean (no webfont files)
      fontSans: 'Ubuntu, system-ui, sans-serif',
      fontHeading: "Georgia, 'Times New Roman', 'Times', serif",
    });
    const asContract: ThemeSettings = defaults;
    expect(asContract.fontHeading).toBe("Georgia, 'Times New Roman', 'Times', serif");
    expect(asContract.fontSans).toBe('Ubuntu, system-ui, sans-serif');
  });

  it('still allows arbitrary author keys alongside the documented ones (open-ended)', () => {
    const defaults = defineThemeSettings({
      fontHeading: 'serif',
      someCustomKnob: 7,
    });
    expect(defaults.someCustomKnob).toBe(7);
  });

  it('accepts the bounded chrome-flag keys with their enum values (3.9e-ii boutique)', () => {
    // The storefront reads these as bounded chrome variants (not CSS vars). The SDK doc-types them so a
    // theme author gets autocomplete on the allowed values; the storefront still validates defensively.
    const boutique = defineThemeSettings<KnownThemeSettings>({
      background: '#faf7f2',
      foreground: '#2b2622',
      primary: '#7c3a2d',
      fontHeading: "Georgia, 'Times New Roman', 'Times', serif",
      'header.layout': 'mega',
      'cart.affordance': 'page-link',
    });
    const asContract: ThemeSettings = boutique;
    expect(asContract['header.layout']).toBe('mega');
    expect(asContract['cart.affordance']).toBe('page-link');
    // The default (unchanged) variants type-check too.
    const simple = defineThemeSettings<KnownThemeSettings>({
      'header.layout': 'simple',
      'cart.affordance': 'drawer',
    });
    expect(simple['header.layout']).toBe('simple');
  });
});
