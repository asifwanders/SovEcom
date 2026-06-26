/**
 * BUNDLED_MODULES registry — unit tests for the install ALLOWLIST + path resolution.
 *
 * The registry is the single source of truth for the platform's built-in modules and the
 * security gate for the setup install path: ONLY ids on the allowlist are installable, and a
 * traversing/arbitrary name must never resolve to a path outside the bundled dir.
 */
import * as os from 'os';
import * as path from 'path';
import {
  BUNDLED_MODULES,
  isBundledModuleId,
  bundledModule,
  bundledTgzPath,
  bundledModulesDir,
} from './bundled-modules';

describe('BUNDLED_MODULES registry', () => {
  it('ships the four reference built-ins (ids = manifest names)', () => {
    const ids = BUNDLED_MODULES.map((m) => m.id).sort();
    expect(ids).toEqual(['notify-back-in-stock', 'recently-viewed', 'reviews', 'wishlist'].sort());
  });

  it('every entry carries a non-empty description and a module dir', () => {
    for (const m of BUNDLED_MODULES) {
      expect(typeof m.description).toBe('string');
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.dir).toMatch(/^modules\//);
    }
  });

  it('is frozen (the allowlist cannot be mutated at runtime)', () => {
    expect(Object.isFrozen(BUNDLED_MODULES)).toBe(true);
    expect(() => {
      (BUNDLED_MODULES as unknown as { push: (x: unknown) => void }).push({});
    }).toThrow();
  });
});

describe('isBundledModuleId — the install allowlist gate', () => {
  it('accepts a known built-in id', () => {
    expect(isBundledModuleId('reviews')).toBe(true);
    expect(isBundledModuleId('notify-back-in-stock')).toBe(true);
  });

  it('rejects an unknown name', () => {
    expect(isBundledModuleId('totally-made-up')).toBe(false);
    expect(isBundledModuleId('')).toBe(false);
  });

  it('rejects a path-traversing / separator-bearing name (no FS reachable)', () => {
    expect(isBundledModuleId('../evil')).toBe(false);
    expect(isBundledModuleId('../../etc/passwd')).toBe(false);
    expect(isBundledModuleId('reviews/../wishlist')).toBe(false);
    expect(isBundledModuleId('/etc/passwd')).toBe(false);
    expect(isBundledModuleId('reviews\0')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isBundledModuleId(undefined)).toBe(false);
    expect(isBundledModuleId(null)).toBe(false);
    expect(isBundledModuleId(42 as unknown)).toBe(false);
    expect(isBundledModuleId({ id: 'reviews' } as unknown)).toBe(false);
  });
});

describe('bundledModule / bundledTgzPath', () => {
  it('resolves the registry entry for a known id', () => {
    expect(bundledModule('reviews')?.id).toBe('reviews');
    expect(bundledModule('nope')).toBeUndefined();
  });

  it('bundledTgzPath returns <dir>/<id>.tgz for an allowlisted id, inside the bundled dir', () => {
    const p = bundledTgzPath('reviews');
    expect(p).toBe(path.join(bundledModulesDir(), 'reviews.tgz'));
    expect(p.startsWith(bundledModulesDir() + path.sep)).toBe(true);
  });

  it('bundledTgzPath THROWS for a non-bundled / traversing id (never resolves a path)', () => {
    expect(() => bundledTgzPath('../evil')).toThrow();
    expect(() => bundledTgzPath('unknown')).toThrow();
  });

  it('honours BUNDLED_MODULES_PATH for the bundled dir', () => {
    const prev = process.env['BUNDLED_MODULES_PATH'];
    const tmp = path.join(os.tmpdir(), 'bundled-test-dir');
    process.env['BUNDLED_MODULES_PATH'] = tmp;
    try {
      expect(bundledModulesDir()).toBe(path.resolve(tmp));
      expect(bundledTgzPath('wishlist')).toBe(path.join(path.resolve(tmp), 'wishlist.tgz'));
    } finally {
      if (prev === undefined) delete process.env['BUNDLED_MODULES_PATH'];
      else process.env['BUNDLED_MODULES_PATH'] = prev;
    }
  });
});
