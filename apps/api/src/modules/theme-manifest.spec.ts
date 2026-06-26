/**
 * ThemeManifest unit tests.
 *
 * PURE data-validation tests for `sovecom.theme.json`: a valid manifest parses; bad semver,
 * a non-slug name, an unknown top-level key, an oversized blob, and an incompatible-core
 * range are each rejected. The semver gate reuses {@link assertCoreCompatible} (shared with
 * modules), so a theme is gated identically to a module against `CORE_API_VERSION`.
 */
import {
  parseAndVerifyThemeManifest,
  assertCoreCompatible,
  themeManifestSchema,
  type ThemeManifest,
} from './theme-manifest';
import { MANIFEST_MAX_BYTES } from './module-manifest';
import { CORE_API_VERSION } from './core-version';

/** A minimal, valid theme manifest. */
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'aurora',
    displayName: 'Aurora',
    version: '1.0.0',
    compatibleCore: '^1.0.0',
    slots: ['product-page', 'footer'],
    settingsSchema: './settings.schema.json',
    ...overrides,
  };
}

describe('themeManifestSchema', () => {
  it('parses a valid manifest', () => {
    const parsed = themeManifestSchema.parse(validManifest());
    expect(parsed.name).toBe('aurora');
    expect(parsed.slots).toEqual(['product-page', 'footer']);
    expect(parsed.settingsSchema).toBe('./settings.schema.json');
  });

  it('parses a minimal manifest (no slots/settingsSchema)', () => {
    const parsed = themeManifestSchema.parse({
      name: 'minimal',
      displayName: 'Minimal',
      version: '2.3.4',
      compatibleCore: '1.0.0',
    });
    expect(parsed.name).toBe('minimal');
    expect(parsed.slots).toBeUndefined();
  });

  it('rejects an uppercase / non-slug name', () => {
    expect(themeManifestSchema.safeParse(validManifest({ name: 'Aurora' })).success).toBe(false);
    expect(themeManifestSchema.safeParse(validManifest({ name: '1aurora' })).success).toBe(false);
    expect(themeManifestSchema.safeParse(validManifest({ name: 'au rora' })).success).toBe(false);
  });

  it('rejects an invalid semver version', () => {
    const r = themeManifestSchema.safeParse(validManifest({ version: 'not-a-version' }));
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('version');
  });

  it('rejects an invalid compatibleCore range', () => {
    const r = themeManifestSchema.safeParse(validManifest({ compatibleCore: 'banana' }));
    expect(r.success).toBe(false);
  });

  it('rejects an unknown top-level key (strict)', () => {
    const r = themeManifestSchema.safeParse(validManifest({ permissions: ['read:products'] }));
    expect(r.success).toBe(false);
  });

  it('rejects a non-slug slot', () => {
    expect(themeManifestSchema.safeParse(validManifest({ slots: ['Product-Page'] })).success).toBe(
      false,
    );
  });
});

describe('parseAndVerifyThemeManifest', () => {
  it('parses + returns the typed manifest', () => {
    const manifest = parseAndVerifyThemeManifest(JSON.stringify(validManifest()));
    expect(manifest.name).toBe('aurora');
    expect(manifest.version).toBe('1.0.0');
  });

  it('throws on non-JSON', () => {
    expect(() => parseAndVerifyThemeManifest('not json {')).toThrow(/not valid JSON/i);
  });

  it('throws on an oversized manifest (byte cap)', () => {
    const huge = JSON.stringify(validManifest({ displayName: 'x'.repeat(MANIFEST_MAX_BYTES) }));
    expect(() => parseAndVerifyThemeManifest(huge)).toThrow(/too large|cap|exceed/i);
  });

  it('throws on an invalid manifest with a descriptive message', () => {
    expect(() =>
      parseAndVerifyThemeManifest(JSON.stringify(validManifest({ name: 'BAD' }))),
    ).toThrow(/invalid theme manifest|name/i);
  });
});

describe('assertCoreCompatible (shared with modules)', () => {
  it('accepts a range that includes the current core on the same major', () => {
    expect(() => assertCoreCompatible({ compatibleCore: `^${CORE_API_VERSION}` })).not.toThrow();
    expect(() => assertCoreCompatible({ compatibleCore: '>=1.0.0' })).not.toThrow();
  });

  it('throws when the range targets a different major (incompatible)', () => {
    expect(() => assertCoreCompatible({ compatibleCore: '^2.0.0' })).toThrow(
      /compatible|major|version/i,
    );
    expect(() => assertCoreCompatible({ compatibleCore: '^0.9.0' })).toThrow();
  });

  it('a parsed manifest pinned to a future major fails the gate', () => {
    const manifest: ThemeManifest = parseAndVerifyThemeManifest(
      JSON.stringify(validManifest({ compatibleCore: '^2.0.0' })),
    );
    expect(() => assertCoreCompatible(manifest)).toThrow(/compatible|major|version/i);
  });
});
