import { describe, it, expect } from 'vitest';
import {
  parseAndVerifyThemeManifest,
  themeManifestSchema,
  assertCoreCompatible,
  MANIFEST_MAX_BYTES,
  CORE_API_VERSION,
  PAGE_TYPES,
} from '../src/index.js';

/**
 * These re-homed validators are now the SINGLE source of truth (apps/api re-exports them).
 * The fixtures below mirror the in-tree apps/api `theme-manifest.spec.ts` cases so any
 * behavioural drift surfaces here.
 */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'aurora',
    displayName: 'Aurora',
    version: '1.2.3',
    compatibleCore: '^1.0.0',
    slots: ['product-page', 'cart-drawer'],
    settingsSchema: './settings.schema.json',
    ...overrides,
  };
}

describe('parseAndVerifyThemeManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m = parseAndVerifyThemeManifest(JSON.stringify(validManifest()));
    expect(m.name).toBe('aurora');
    expect(m.version).toBe('1.2.3');
    expect(m.slots).toEqual(['product-page', 'cart-drawer']);
    expect(m.settingsSchema).toBe('./settings.schema.json');
  });

  it('accepts a minimal manifest (no optional slots/settingsSchema)', () => {
    const m = parseAndVerifyThemeManifest(
      JSON.stringify({
        name: 'minimal',
        displayName: 'Minimal',
        version: '0.1.0',
        compatibleCore: '^1.0.0',
      }),
    );
    expect(m.slots).toBeUndefined();
    expect(m.settingsSchema).toBeUndefined();
  });

  it('rejects invalid JSON', () => {
    expect(() => parseAndVerifyThemeManifest('{not json')).toThrow(/not valid JSON/);
  });

  it('rejects an unknown top-level key (.strict)', () => {
    const raw = JSON.stringify(validManifest({ rogue: 'extra' }));
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/invalid theme manifest/);
  });

  it('rejects a manifest exceeding the byte cap', () => {
    const big = parseAndVerifyThemeManifest;
    const raw = JSON.stringify(validManifest({ displayName: 'x'.repeat(MANIFEST_MAX_BYTES + 1) }));
    expect(() => big(raw)).toThrow(/too large/);
  });

  it('rejects a non-slug name', () => {
    const raw = JSON.stringify(validManifest({ name: 'Aurora_Theme' }));
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/name must be a lowercase slug/);
  });

  it('rejects an invalid-semver version', () => {
    const raw = JSON.stringify(validManifest({ version: 'not-a-version' }));
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/version must be a valid semver/);
  });

  it('rejects an invalid compatibleCore range', () => {
    const raw = JSON.stringify(validManifest({ compatibleCore: 'garbage range' }));
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/valid semver range/);
  });

  it('rejects a bad slot slug', () => {
    const raw = JSON.stringify(validManifest({ slots: ['Product-Page'] }));
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/slot must be a lowercase slug/);
  });

  it('rejects duplicate slots (a slot may be declared at most once)', () => {
    const raw = JSON.stringify(validManifest({ slots: ['product-page', 'product-page'] }));
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/at most once/);
  });
});

describe('themeManifestSchema', () => {
  it('is .strict() at the top level', () => {
    const r = themeManifestSchema.safeParse(validManifest({ extra: 1 }));
    expect(r.success).toBe(false);
  });
});

describe('manifest templates[] declaration', () => {
  it('accepts a manifest with NO templates (tokens-only theme, the default)', () => {
    const m = parseAndVerifyThemeManifest(JSON.stringify(validManifest()));
    expect(m.templates).toBeUndefined();
  });

  it('accepts a valid templates declaration and returns it typed', () => {
    const m = parseAndVerifyThemeManifest(
      JSON.stringify(
        validManifest({
          templates: [
            { page: 'home', path: 'templates/home.json' },
            { page: 'product', path: 'product.json' },
          ],
        }),
      ),
    );
    expect(m.templates).toEqual([
      { page: 'home', path: 'templates/home.json' },
      { page: 'product', path: 'product.json' },
    ]);
  });

  it('accepts paths with slug segments, digits, underscores and hyphens', () => {
    const m = parseAndVerifyThemeManifest(
      JSON.stringify(
        validManifest({ templates: [{ page: 'home', path: 'a/b1/c_d-e/home-2.json' }] }),
      ),
    );
    expect(m.templates?.[0]?.path).toBe('a/b1/c_d-e/home-2.json');
  });

  it('rejects an unknown page type', () => {
    const raw = JSON.stringify(
      validManifest({ templates: [{ page: 'about', path: 'about.json' }] }),
    );
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/invalid theme manifest/);
  });

  it('rejects a traversal (..) path', () => {
    const raw = JSON.stringify(
      validManifest({ templates: [{ page: 'home', path: '../etc/home.json' }] }),
    );
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/relative .json slug path/);
  });

  it('rejects a path with a .. segment in the middle', () => {
    const raw = JSON.stringify(
      validManifest({ templates: [{ page: 'home', path: 'templates/../../home.json' }] }),
    );
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/relative .json slug path/);
  });

  it('rejects an absolute (leading /) path', () => {
    const raw = JSON.stringify(
      validManifest({ templates: [{ page: 'home', path: '/etc/passwd.json' }] }),
    );
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/relative .json slug path/);
  });

  it('rejects a non-.json path', () => {
    const raw = JSON.stringify(
      validManifest({ templates: [{ page: 'home', path: 'templates/home.yaml' }] }),
    );
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/relative .json slug path/);
  });

  it('rejects a Windows-separator path', () => {
    const raw = JSON.stringify(
      validManifest({ templates: [{ page: 'home', path: 'templates\\home.json' }] }),
    );
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/relative .json slug path/);
  });

  it('rejects a duplicate page type', () => {
    const raw = JSON.stringify(
      validManifest({
        templates: [
          { page: 'home', path: 'home.json' },
          { page: 'home', path: 'home2.json' },
        ],
      }),
    );
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/at most once/);
  });

  it('rejects more template declarations than page types (over-bound)', () => {
    const tooMany = [...PAGE_TYPES, 'home'].map((page, i) => ({ page, path: `t${i}.json` }));
    const raw = JSON.stringify(validManifest({ templates: tooMany }));
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/invalid theme manifest/);
  });

  it('rejects an unknown key inside a template declaration (.strict)', () => {
    const raw = JSON.stringify(
      validManifest({ templates: [{ page: 'home', path: 'home.json', rogue: 1 }] }),
    );
    expect(() => parseAndVerifyThemeManifest(raw)).toThrow(/invalid theme manifest/);
  });
});

describe('assertCoreCompatible (shared with @sovecom/module-sdk)', () => {
  it('accepts a range that satisfies the current core on the same major', () => {
    expect(() => assertCoreCompatible({ compatibleCore: '^1.0.0' })).not.toThrow();
  });

  it('rejects a core-incompatible (future-major) range', () => {
    expect(() => assertCoreCompatible({ compatibleCore: '^2.0.0' })).toThrow(/not compatible/);
  });

  it('rejects an old-major range', () => {
    expect(() => assertCoreCompatible({ compatibleCore: '^0.1.0' })).toThrow(/not compatible/);
  });

  it('exposes the single CORE_API_VERSION home', () => {
    expect(typeof CORE_API_VERSION).toBe('string');
    expect(CORE_API_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
