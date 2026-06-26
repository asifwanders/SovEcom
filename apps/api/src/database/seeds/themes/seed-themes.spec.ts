/**
 * Follow-up A — unit tests for the PURE parts of the bundled-theme seed: the canonical seed list
 * and the manifest builder. The DB-touching `seedBundledThemes` (insert + guarded activate) is
 * covered by the real-Postgres integration spec (`test/integration/.../bundled-themes-seed.int-spec.ts`).
 *
 * The load-bearing invariants proved here: every constructed manifest PASSES
 * `parseAndVerifyThemeManifest` (the data validator — so the seed can never persist a row whose
 * manifest the admin list/install path would reject) AND `assertCoreCompatible` (the core-version
 * MAJOR gate — so a `CORE_API_VERSION` bump that outdates the bundled `compatibleCore` is caught at
 * test time, not silently shipped).
 */
import { assertCoreCompatible, parseAndVerifyThemeManifest } from '../../../modules/theme-manifest';
import { BUNDLED_THEME_SEEDS, DEFAULT_SEED_THEME_NAME, bundledThemeManifest } from './seed-themes';

describe('seed-themes (pure)', () => {
  it('ships exactly the two bundled themes (default + boutique), mirroring the storefront', () => {
    expect(BUNDLED_THEME_SEEDS.map((s) => s.name)).toEqual(['default', 'boutique']);
  });

  it('includes the default theme name as the one activated when no theme is active', () => {
    expect(BUNDLED_THEME_SEEDS.some((s) => s.name === DEFAULT_SEED_THEME_NAME)).toBe(true);
  });

  it('every bundled manifest PASSES parseAndVerifyThemeManifest', () => {
    for (const seed of BUNDLED_THEME_SEEDS) {
      const manifest = bundledThemeManifest(seed);
      // The verifier takes the RAW json string (it enforces the byte cap + JSON parse first).
      const verified = parseAndVerifyThemeManifest(JSON.stringify(manifest));
      expect(verified.name).toBe(seed.name);
      expect(verified.displayName).toBe(seed.displayName);
      expect(verified.version).toBe(seed.version);
      expect(verified.compatibleCore).toBe('^1.0.0');
    }
  });

  it('every bundled manifest PASSES assertCoreCompatible against the current core version', () => {
    for (const seed of BUNDLED_THEME_SEEDS) {
      // The core-version MAJOR gate the install path applies (and the seed otherwise bypasses). If a
      // future CORE_API_VERSION bump outdates `compatibleCore`, THIS throws — the self-gate's safety net.
      expect(() => assertCoreCompatible(bundledThemeManifest(seed))).not.toThrow();
    }
  });

  it('builds a slug name + valid semver + a compatibleCore range the core accepts', () => {
    const m = bundledThemeManifest({ name: 'boutique', displayName: 'Boutique', version: '1.0.0' });
    expect(m.name).toMatch(/^[a-z][a-z0-9-]*$/);
    // Round-trips cleanly through the verifier (no throw).
    expect(() => parseAndVerifyThemeManifest(JSON.stringify(m))).not.toThrow();
  });
});
