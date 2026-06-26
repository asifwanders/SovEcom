import { describe, it, expect } from 'vitest';
import { defineTheme, defineThemeSlots } from '../src/index.js';
import type { ThemeManifest } from '../src/index.js';

const valid: ThemeManifest = {
  name: 'aurora',
  displayName: 'Aurora',
  version: '1.0.0',
  compatibleCore: '^1.0.0',
  slots: ['product-page'],
};

describe('defineTheme', () => {
  it('returns the validated manifest object (NOT an { activate } entry)', () => {
    const theme = defineTheme(valid);
    expect(theme.name).toBe('aurora');
    expect(theme.version).toBe('1.0.0');
    expect(theme.slots).toEqual(['product-page']);
    // A theme is a declarative asset: no runtime entrypoint.
    expect('activate' in theme).toBe(false);
  });

  it('round-trips through the canonical validator (strips nothing valid, returns typed manifest)', () => {
    const theme = defineTheme({ ...valid, settingsSchema: './s.json' });
    expect(theme.settingsSchema).toBe('./s.json');
  });

  it('throws on a non-object config', () => {
    // @ts-expect-error — author passed a non-object config
    expect(() => defineTheme(null)).toThrow(/config must be an object/);
  });

  it('throws on a bad slug name', () => {
    // @ts-expect-error — validated at runtime; type is loose enough to test the throw
    expect(() => defineTheme({ ...valid, name: 'Bad_Name' })).toThrow(/lowercase slug/);
  });

  it('throws on invalid semver version', () => {
    expect(() => defineTheme({ ...valid, version: 'nope' })).toThrow(/valid semver/);
  });

  it('throws on an unknown top-level key (.strict)', () => {
    // @ts-expect-error — unknown key rejected by .strict()
    expect(() => defineTheme({ ...valid, rogue: 1 })).toThrow(/invalid theme manifest/);
  });

  it('composes with defineThemeSlots (the README pattern typechecks and validates)', () => {
    // defineThemeSlots returns a FROZEN readonly array; this assignment is the compile-time proof
    // that `DefineThemeConfig.slots` accepts it. The runtime round-trip still validates via the
    // schema/byte-cap/.strict pipeline and returns a plain mutable string[] manifest.
    const theme = defineTheme({
      ...valid,
      slots: defineThemeSlots(['product-page', 'footer']),
    });
    expect(theme.slots).toEqual(['product-page', 'footer']);
    expect('activate' in theme).toBe(false);
  });
});
