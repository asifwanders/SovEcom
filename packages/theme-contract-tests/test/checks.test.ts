import { describe, it, expect, afterEach } from 'vitest';
import { runThemeContractChecks } from '../src/index.js';
import {
  makeThemeDir,
  defaultManifest,
  cleanupFixtures,
  MIT_LICENSE,
  AGPL_LICENSE,
} from './fixtures.js';

afterEach(() => cleanupFixtures());

/** Helper: find a check result by id. */
function check(report: ReturnType<typeof runThemeContractChecks>, id: string) {
  const c = report.checks.find((r) => r.id === id);
  if (!c) throw new Error(`no check with id "${id}" in report`);
  return c;
}

describe('runThemeContractChecks — report shape', () => {
  it('returns the four hard checks with ok=true on a clean theme', () => {
    const dir = makeThemeDir({ manifest: defaultManifest('demo') });
    const report = runThemeContractChecks(dir);
    expect(report.ok).toBe(true);
    const ids = report.checks.map((c) => c.id).sort();
    expect(ids).toEqual(
      ['core-version-compatible', 'license-mit', 'manifest-valid', 'slots-valid'].sort(),
    );
    // A theme has no advisory checks — every check is hard.
    expect(report.checks.every((c) => c.kind === 'hard')).toBe(true);
  });
});

describe('check 1 — manifest valid', () => {
  it('FAILS on a syntactically invalid manifest (bad JSON)', () => {
    const dir = makeThemeDir({ manifest: '{ not json' });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'manifest-valid').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('FAILS on a schema-invalid manifest (unknown top-level key, .strict())', () => {
    const dir = makeThemeDir({
      manifest: defaultManifest('demo', { permissions: ['read:products'] }),
    });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'manifest-valid').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('FAILS when sovecom.theme.json is missing', () => {
    const dir = makeThemeDir({ omitManifest: true });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'manifest-valid').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('PASSES on a valid manifest', () => {
    const dir = makeThemeDir({ manifest: defaultManifest('demo') });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'manifest-valid').status).toBe('pass');
  });
});

describe('check 2 — core-version compatible', () => {
  it('FAILS when compatibleCore targets an old major (^0.x)', () => {
    const dir = makeThemeDir({ manifest: defaultManifest('demo', { compatibleCore: '^0.5.0' }) });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'core-version-compatible').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('FAILS when compatibleCore targets a future major (^2.0.0)', () => {
    const dir = makeThemeDir({ manifest: defaultManifest('demo', { compatibleCore: '^2.0.0' }) });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'core-version-compatible').status).toBe('fail');
  });

  it('PASSES on ^1.0.0', () => {
    const dir = makeThemeDir({ manifest: defaultManifest('demo', { compatibleCore: '^1.0.0' }) });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'core-version-compatible').status).toBe('pass');
  });
});

describe('check 3 — slots are valid slugs', () => {
  it('FAILS on a bad slot slug (rejected by the manifest schema, surfaced as a named check)', () => {
    // An UPPERCASE slot is rejected by the manifest schema, so the manifest check fails too; the
    // slots check must independently and clearly name the slot-slug issue (honest report).
    const dir = makeThemeDir({ manifest: defaultManifest('demo', { slots: ['Product_Page'] }) });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'slots-valid').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('PASSES when all declared slots are lowercase slugs', () => {
    const dir = makeThemeDir({
      manifest: defaultManifest('demo', { slots: ['product-page', 'cart-summary'] }),
    });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'slots-valid').status).toBe('pass');
  });

  it('PASSES when no slots are declared (a theme may declare zero slots)', () => {
    const dir = makeThemeDir({ manifest: defaultManifest('demo', { slots: [] }) });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'slots-valid').status).toBe('pass');
  });
});

describe('check 4 — LICENSE is MIT', () => {
  it('PASSES on the canonical MIT License', () => {
    const dir = makeThemeDir({ license: MIT_LICENSE });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'license-mit').status).toBe('pass');
  });

  it('PASSES on MIT text with mangled whitespace (robust to wrapping)', () => {
    const mangled = MIT_LICENSE.replace(/\n/g, '   \t  ').replace(/ {2}/g, '  ');
    const dir = makeThemeDir({ license: mangled });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'license-mit').status).toBe('pass');
  });

  it('FAILS when the LICENSE is AGPL (the module license, not allowed for themes)', () => {
    const dir = makeThemeDir({ license: AGPL_LICENSE });
    const report = runThemeContractChecks(dir);
    const c = check(report, 'license-mit');
    expect(c.status).toBe('fail');
    expect(c.messages.join(' ').toLowerCase()).toMatch(/agpl|affero/);
    expect(report.ok).toBe(false);
  });

  it('FAILS when LICENSE is missing', () => {
    const dir = makeThemeDir({ omitLicense: true });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'license-mit').status).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('FAILS when LICENSE merely mentions "MIT" but is not the MIT text', () => {
    const dir = makeThemeDir({ license: 'This project is sort of MIT-ish, trust me.\n' });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'license-mit').status).toBe('fail');
  });

  it('PASSES on MIT text with typographic (curly) quotes around AS IS', () => {
    // Some editors/word-processors auto-convert the ASCII quotes in `"AS IS"` to U+201C/U+201D.
    // That is still a valid MIT license and must not fail closed.
    const curly = MIT_LICENSE.replace('"AS IS"', '“AS IS”');
    const dir = makeThemeDir({ license: curly });
    const report = runThemeContractChecks(dir);
    expect(check(report, 'license-mit').status).toBe('pass');
  });
});

describe('a theme with multiple simultaneous mistakes', () => {
  it('fails every relevant hard check at once and ok=false', () => {
    const dir = makeThemeDir({
      manifest: defaultManifest('demo', { compatibleCore: '^0.1.0', slots: ['Bad_Slug'] }),
      license: AGPL_LICENSE,
    });
    const report = runThemeContractChecks(dir);
    expect(report.ok).toBe(false);
    expect(check(report, 'core-version-compatible').status).toBe('fail');
    expect(check(report, 'slots-valid').status).toBe('fail');
    expect(check(report, 'license-mit').status).toBe('fail');
  });
});
