import { describe, it, expect } from 'vitest';
import { createNamespacedTable, moduleManifestSchema } from '../src/index.js';

describe('createNamespacedTable', () => {
  it('builds a mod_<name>_<suffix> identifier', () => {
    expect(createNamespacedTable('wishlist', 'items')).toBe('mod_wishlist_items');
    expect(createNamespacedTable('my-mod', 'saved_items')).toBe('mod_my-mod_saved_items');
  });

  it('rejects an invalid module name', () => {
    expect(() => createNamespacedTable('Wishlist', 'items')).toThrow(/must be a lowercase slug/);
    expect(() => createNamespacedTable('1mod', 'items')).toThrow(/must be a lowercase slug/);
    expect(() => createNamespacedTable('', 'items')).toThrow(/must be a lowercase slug/);
  });

  it('rejects an invalid table suffix', () => {
    expect(() => createNamespacedTable('wishlist', 'Items')).toThrow(/must be lowercase/);
    expect(() => createNamespacedTable('wishlist', 'my items')).toThrow(/must be lowercase/);
    expect(() => createNamespacedTable('wishlist', '')).toThrow(/must be lowercase/);
    expect(() => createNamespacedTable('wishlist', 'a-b')).toThrow(/must be lowercase/);
  });

  it('rejects a suffix that re-introduces the mod_ prefix', () => {
    expect(() => createNamespacedTable('wishlist', 'mod_other_items')).toThrow(/reserved "mod_"/);
  });

  it('produces a name the manifest tables rule accepts (parity)', () => {
    const table = createNamespacedTable('wishlist', 'items');
    const manifest = {
      name: 'wishlist',
      displayName: 'Wishlist',
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      permissions: ['write:own_tables'],
      tables: [table],
    };
    expect(moduleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('a name for the WRONG module fails the manifest tables rule', () => {
    const table = createNamespacedTable('other', 'items'); // mod_other_items
    const manifest = {
      name: 'wishlist',
      displayName: 'Wishlist',
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      permissions: ['write:own_tables'],
      tables: [table],
    };
    expect(moduleManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
