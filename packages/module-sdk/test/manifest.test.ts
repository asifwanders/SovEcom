import { describe, it, expect } from 'vitest';
import {
  parseAndVerifyManifest,
  assertCoreCompatible,
  MODULE_PERMISSION_ALLOWLIST,
  MANIFEST_MAX_BYTES,
  CORE_API_VERSION,
} from '../src/index.js';

/**
 * These re-homed validators are now the SINGLE source of truth (apps/api re-exports them).
 * The fixtures below mirror the in-tree apps/api `module-manifest.spec.ts` cases so any
 * behavioural drift surfaces here.
 */
const VALID = JSON.stringify({
  name: 'wishlist',
  displayName: 'Wishlist',
  version: '1.2.3',
  compatibleCore: '^1.0.0',
  permissions: ['read:products', 'write:own_tables'],
  slots: [{ slot: 'product-page', component: 'wishlist-button' }],
  tables: ['mod_wishlist_items'],
});

describe('parseAndVerifyManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m = parseAndVerifyManifest(VALID);
    expect(m.name).toBe('wishlist');
    expect(m.permissions).toContain('write:own_tables');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseAndVerifyManifest('{not json')).toThrow(/not valid JSON/);
  });

  it('rejects an unknown top-level key (.strict)', () => {
    const raw = JSON.stringify({
      name: 'x',
      displayName: 'X',
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      permissions: [],
      evil: true,
    });
    expect(() => parseAndVerifyManifest(raw)).toThrow(/invalid module manifest/);
  });

  it('rejects a permission outside the allowlist (default-deny)', () => {
    const raw = JSON.stringify({
      name: 'x',
      displayName: 'X',
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      permissions: ['write:core_tables'],
    });
    expect(() => parseAndVerifyManifest(raw)).toThrow(/invalid module manifest/);
  });

  it('rejects a non-namespaced table', () => {
    const raw = JSON.stringify({
      name: 'wishlist',
      displayName: 'Wishlist',
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      permissions: ['write:own_tables'],
      tables: ['orders'],
    });
    expect(() => parseAndVerifyManifest(raw)).toThrow(/must be namespaced/);
  });

  it('rejects a duplicate slot', () => {
    const raw = JSON.stringify({
      name: 'wishlist',
      displayName: 'Wishlist',
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      permissions: [],
      slots: [
        { slot: 'product-page', component: 'a' },
        { slot: 'product-page', component: 'b' },
      ],
    });
    expect(() => parseAndVerifyManifest(raw)).toThrow(/declared more than once/);
  });

  it('rejects an oversized manifest', () => {
    const filler = 'x'.repeat(MANIFEST_MAX_BYTES);
    const raw = JSON.stringify({
      name: 'x',
      displayName: filler,
      version: '1.0.0',
      compatibleCore: '^1.0.0',
      permissions: [],
    });
    expect(() => parseAndVerifyManifest(raw)).toThrow(/too large/);
  });
});

describe('assertCoreCompatible', () => {
  it('accepts a range that matches the core major', () => {
    expect(() => assertCoreCompatible({ compatibleCore: '^1.0.0' })).not.toThrow();
    expect(() => assertCoreCompatible({ compatibleCore: '>=1.0.0' })).not.toThrow();
    expect(() => assertCoreCompatible({ compatibleCore: '1.x' })).not.toThrow();
  });

  it('rejects a range pinned to an older major', () => {
    expect(() => assertCoreCompatible({ compatibleCore: '^0.9.0' })).toThrow(/not compatible/);
  });

  it('rejects a future-only major', () => {
    expect(() => assertCoreCompatible({ compatibleCore: '^2.0.0' })).toThrow(/not compatible/);
  });
});

describe('exported constants', () => {
  it('exposes the v1 permission allowlist', () => {
    expect(MODULE_PERMISSION_ALLOWLIST).toContain('read:products');
    expect(MODULE_PERMISSION_ALLOWLIST).toContain('http:outbound');
    // `register:slot` was removed.
    expect(MODULE_PERMISSION_ALLOWLIST as readonly string[]).not.toContain('register:slot');
  });

  it('exposes the core API contract version', () => {
    expect(CORE_API_VERSION).toBe('1.0.0');
  });
});
