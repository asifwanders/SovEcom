import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAndVerifyThemeManifest,
  assertCoreCompatible,
  SLOT_SLUG_RE,
} from '@sovecom/theme-sdk';
import { scaffoldTheme, InvalidThemeNameError } from '../src/scaffold.js';

/**
 * the non-interactive scaffolder. These tests are the spec:
 * a bad name fails loudly; a good name produces a MINIMAL MIT skeleton whose manifest passes the
 * SDK's OWN validators (single source of truth — no second, drifting checker), with valid slot
 * slugs and an MIT (not AGPL) LICENSE.
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cst-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('scaffoldTheme — name validation (reuses the SDK slug rule)', () => {
  it('rejects an invalid (non-slug) theme name with InvalidThemeNameError', () => {
    expect(() => scaffoldTheme({ themeName: 'Bad Name!', targetDir: tmpRoot })).toThrow(
      InvalidThemeNameError,
    );
  });

  it('rejects an empty theme name', () => {
    expect(() => scaffoldTheme({ themeName: '', targetDir: tmpRoot })).toThrow(
      InvalidThemeNameError,
    );
  });

  it('rejects a name starting with a digit', () => {
    expect(() => scaffoldTheme({ themeName: '1aurora', targetDir: tmpRoot })).toThrow(
      InvalidThemeNameError,
    );
  });

  it('rejects an UPPERCASE name', () => {
    expect(() => scaffoldTheme({ themeName: 'Aurora', targetDir: tmpRoot })).toThrow(
      InvalidThemeNameError,
    );
  });

  it('accepts a valid lowercase slug', () => {
    const dir = scaffoldTheme({ themeName: 'aurora', targetDir: tmpRoot });
    expect(existsSync(dir)).toBe(true);
  });
});

describe('scaffoldTheme — emitted tree (minimal MIT skeleton, NO React/Next)', () => {
  const themeName = 'aurora';
  let outDir: string;

  beforeEach(() => {
    outDir = scaffoldTheme({ themeName, targetDir: tmpRoot });
  });

  it('emits every expected file', () => {
    const expected = [
      'sovecom.theme.json',
      'settings.schema.json',
      'package.json',
      'tsconfig.json',
      'src/theme.ts',
      'src/slots.ts',
      'src/settings.ts',
      'README.md',
      '.gitignore',
      'LICENSE',
    ];
    for (const rel of expected) {
      expect(existsSync(join(outDir, rel)), `${rel} should exist`).toBe(true);
    }
  });

  it('does NOT emit React/Next files (minimal skeleton)', () => {
    for (const rel of ['next.config.js', 'tailwind.config.js', 'app', 'components']) {
      expect(existsSync(join(outDir, rel)), `${rel} must NOT be scaffolded`).toBe(false);
    }
  });

  it('refuses to overwrite a non-empty target directory', () => {
    expect(() => scaffoldTheme({ themeName, targetDir: tmpRoot })).toThrow(/already exists/i);
  });

  it('substitutes the theme name into every emitted text file (no placeholder leaks)', () => {
    for (const rel of [
      'sovecom.theme.json',
      'settings.schema.json',
      'package.json',
      'src/theme.ts',
      'src/slots.ts',
      'README.md',
    ]) {
      const raw = readFileSync(join(outDir, rel), 'utf8');
      expect(raw, `${rel} must not contain unsubstituted placeholders`).not.toMatch(
        /__THEME_NAME__/,
      );
    }
  });
});

describe('scaffoldTheme — generated manifest passes the SDK validators', () => {
  it('parseAndVerifyThemeManifest accepts the generated manifest', () => {
    const outDir = scaffoldTheme({ themeName: 'aurora', targetDir: tmpRoot });
    const raw = readFileSync(join(outDir, 'sovecom.theme.json'), 'utf8');
    const manifest = parseAndVerifyThemeManifest(raw);
    expect(manifest.name).toBe('aurora');
    expect(() => assertCoreCompatible(manifest)).not.toThrow();
  });

  it('declares slots that are all valid slugs', () => {
    const outDir = scaffoldTheme({ themeName: 'aurora', targetDir: tmpRoot });
    const manifest = parseAndVerifyThemeManifest(
      readFileSync(join(outDir, 'sovecom.theme.json'), 'utf8'),
    );
    expect(manifest.slots ?? []).not.toHaveLength(0);
    for (const slot of manifest.slots ?? []) {
      expect(SLOT_SLUG_RE.test(slot), `slot "${slot}" must be a valid slug`).toBe(true);
    }
  });

  it('name and displayName both reflect the theme slug', () => {
    const outDir = scaffoldTheme({ themeName: 'minimal-shop', targetDir: tmpRoot });
    const manifest = parseAndVerifyThemeManifest(
      readFileSync(join(outDir, 'sovecom.theme.json'), 'utf8'),
    );
    expect(manifest.name).toBe('minimal-shop');
    expect(manifest.displayName).toBe('minimal-shop');
  });
});

describe('generated theme — authoring + license shape', () => {
  it('src/theme.ts imports defineTheme and authors a validated manifest', () => {
    const outDir = scaffoldTheme({ themeName: 'aurora', targetDir: tmpRoot });
    const src = readFileSync(join(outDir, 'src/theme.ts'), 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*defineTheme[^}]*\}\s*from\s*['"]@sovecom\/theme-sdk['"]/);
    expect(src).toMatch(/defineTheme\(/);
    // A theme has NO activate / runtime entry.
    expect(src).not.toMatch(/activate/);
  });

  it('src/slots.ts uses defineThemeSlots', () => {
    const outDir = scaffoldTheme({ themeName: 'aurora', targetDir: tmpRoot });
    const src = readFileSync(join(outDir, 'src/slots.ts'), 'utf8');
    expect(src).toMatch(/defineThemeSlots\(/);
  });

  it('generated package.json references @sovecom/theme-sdk and is MIT-licensed', () => {
    const outDir = scaffoldTheme({ themeName: 'aurora', targetDir: tmpRoot });
    const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8')) as {
      name: string;
      license: string;
      devDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('aurora');
    expect(pkg.license).toBe('MIT');
    expect(pkg.devDependencies['@sovecom/theme-sdk']).toBeDefined();
  });

  it('ships an MIT LICENSE — NOT AGPL (the load-bearing license boundary)', () => {
    const outDir = scaffoldTheme({ themeName: 'aurora', targetDir: tmpRoot });
    const license = readFileSync(join(outDir, 'LICENSE'), 'utf8');
    expect(license).toMatch(/MIT License/);
    expect(license).toMatch(/Permission is hereby granted, free of charge/);
    expect(license).not.toMatch(/GNU AFFERO GENERAL PUBLIC LICENSE/);
  });
});
