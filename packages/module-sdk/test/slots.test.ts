import { describe, it, expect } from 'vitest';
import { defineSlots, moduleManifestSchema } from '../src/index.js';
import type { ModuleSlotEntry } from '../src/index.js';

describe('defineSlots', () => {
  it('builds a valid slot-entry array', () => {
    const slots = defineSlots([
      { slot: 'product-page', component: 'wishlist-button' },
      { slot: 'cart-summary', component: 'cart-banner' },
    ]);
    expect(slots).toEqual([
      { slot: 'product-page', component: 'wishlist-button' },
      { slot: 'cart-summary', component: 'cart-banner' },
    ]);
  });

  it('accepts an empty array', () => {
    expect(defineSlots([])).toEqual([]);
  });

  it('rejects a non-slug slot', () => {
    expect(() => defineSlots([{ slot: 'Product Page', component: 'ok' }])).toThrow(
      /slot "Product Page" must be a lowercase slug/,
    );
  });

  it('rejects a non-slug component', () => {
    expect(() => defineSlots([{ slot: 'product-page', component: 'Bad_Component' }])).toThrow(
      /component "Bad_Component" must be a lowercase slug/,
    );
  });

  it('rejects a slug starting with a digit or hyphen', () => {
    expect(() => defineSlots([{ slot: '1slot', component: 'ok' }])).toThrow(/lowercase slug/);
    expect(() => defineSlots([{ slot: '-slot', component: 'ok' }])).toThrow(/lowercase slug/);
  });

  it('rejects a duplicate slot (a module fills a slot at most once)', () => {
    expect(() =>
      defineSlots([
        { slot: 'product-page', component: 'a' },
        { slot: 'product-page', component: 'b' },
      ]),
    ).toThrow(/declared more than once/);
  });

  it('rejects a non-array argument', () => {
    // @ts-expect-error — author passed a non-array
    expect(() => defineSlots('nope')).toThrow(/entries must be an array/);
  });

  it('produces output the manifest schema accepts (parity with moduleManifestSchema)', () => {
    const slots = defineSlots([{ slot: 'product-page', component: 'wishlist-button' }]);
    const manifest = {
      name: 'wishlist',
      displayName: 'Wishlist',
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      permissions: [],
      slots,
    };
    expect(moduleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('its duplicate rule matches the manifest schema rejecting duplicate slots', () => {
    const dup: ModuleSlotEntry[] = [
      { slot: 'product-page', component: 'a' },
      { slot: 'product-page', component: 'b' },
    ];
    // Manifest schema rejects it...
    expect(
      moduleManifestSchema.safeParse({
        name: 'wishlist',
        displayName: 'Wishlist',
        version: '1.0.0',
        compatibleCore: '^1.0.0',
        permissions: [],
        slots: dup,
      }).success,
    ).toBe(false);
    // ...and so does the helper.
    expect(() => defineSlots(dup)).toThrow(/declared more than once/);
  });
});
