import { describe, it, expect } from 'vitest';
import { defineThemeSettings } from '../src/index.js';
import type { ActiveTheme, SlotMap, SlotBinding, ThemeSettings } from '../src/index.js';

/**
 * Shape tests for the store-contract types. These are compile-time contracts, so the runtime body
 * is light — the real guard is `tsc` accepting these assignments (and the apps/api conformance
 * type-test). We assert the values conform structurally.
 */
describe('store-contract types', () => {
  it('ActiveTheme accepts a { name, version, settings } shape', () => {
    const settings: ThemeSettings = { accent: '#fff', dense: true };
    const active: ActiveTheme = { name: 'aurora', version: '1.0.0', settings };
    expect(active.name).toBe('aurora');
    expect(active.settings.accent).toBe('#fff');
  });

  it('SlotMap maps slot slugs to { module, component } bindings', () => {
    const binding: SlotBinding = { module: 'wishlist', component: 'wishlist-button' };
    const map: SlotMap = { 'product-page': binding };
    expect(map['product-page'].module).toBe('wishlist');
    expect(map['product-page'].component).toBe('wishlist-button');
  });
});

describe('defineThemeSettings', () => {
  it('returns its argument unchanged (pure compile-time helper)', () => {
    const defaults = defineThemeSettings({ accentColor: '#6c5ce7', showBadges: true });
    expect(defaults).toEqual({ accentColor: '#6c5ce7', showBadges: true });
  });
});
