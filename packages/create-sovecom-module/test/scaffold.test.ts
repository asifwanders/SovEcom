import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAndVerifyManifest,
  assertCoreCompatible,
  MODULE_PERMISSION_ALLOWLIST,
} from '@sovecom/module-sdk';
import { scaffoldModule, InvalidModuleNameError } from '../src/scaffold.js';

/**
 * the non-interactive scaffolder. These tests are the spec:
 * a bad name fails loudly; a good name produces a tree whose manifest passes the SDK's OWN
 * validators (single source of truth — no second, drifting checker), with namespaced tables
 * and allowlisted permissions.
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'csm-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('scaffoldModule — name validation (reuses the SDK slug rule)', () => {
  it('rejects an invalid (non-slug) module name with InvalidModuleNameError', () => {
    expect(() => scaffoldModule({ moduleName: 'Bad Name!', targetDir: tmpRoot })).toThrow(
      InvalidModuleNameError,
    );
  });

  it('rejects an empty module name', () => {
    expect(() => scaffoldModule({ moduleName: '', targetDir: tmpRoot })).toThrow(
      InvalidModuleNameError,
    );
  });

  it('rejects a name starting with a digit', () => {
    expect(() => scaffoldModule({ moduleName: '1wishlist', targetDir: tmpRoot })).toThrow(
      InvalidModuleNameError,
    );
  });

  it('rejects an UPPERCASE name', () => {
    expect(() => scaffoldModule({ moduleName: 'Wishlist', targetDir: tmpRoot })).toThrow(
      InvalidModuleNameError,
    );
  });

  it('accepts a valid lowercase slug', () => {
    const dir = scaffoldModule({ moduleName: 'wishlist', targetDir: tmpRoot });
    expect(existsSync(dir)).toBe(true);
  });
});

describe('scaffoldModule — emitted tree', () => {
  const moduleName = 'wishlist';
  let outDir: string;

  beforeEach(() => {
    outDir = scaffoldModule({ moduleName, targetDir: tmpRoot });
  });

  it('emits every expected file', () => {
    const expected = [
      'sovecom.module.json',
      'package.json',
      'tsconfig.json',
      'src/index.ts',
      'src/db/schema.ts',
      'README.md',
      '.gitignore',
      'LICENSE',
    ];
    for (const rel of expected) {
      expect(existsSync(join(outDir, rel)), `${rel} should exist`).toBe(true);
    }
  });

  it('refuses to overwrite a non-empty target directory', () => {
    // outDir already exists and is populated from the beforeEach scaffold.
    expect(() => scaffoldModule({ moduleName, targetDir: tmpRoot })).toThrow(/already exists/i);
  });

  it('substitutes the module name into the manifest (no placeholders leak)', () => {
    const raw = readFileSync(join(outDir, 'sovecom.module.json'), 'utf8');
    expect(raw).not.toMatch(/__MODULE_NAME__/);
    const manifest = JSON.parse(raw) as { name: string };
    expect(manifest.name).toBe(moduleName);
  });

  it('substitutes the module name into every emitted file (no placeholder leaks anywhere)', () => {
    for (const rel of ['src/index.ts', 'src/db/schema.ts', 'package.json', 'README.md']) {
      const raw = readFileSync(join(outDir, rel), 'utf8');
      expect(raw, `${rel} must not contain unsubstituted placeholders`).not.toMatch(
        /__MODULE_NAME__/,
      );
    }
  });
});

describe('scaffoldModule — generated manifest passes the SDK validators', () => {
  it('parseAndVerifyManifest accepts the generated manifest', () => {
    const outDir = scaffoldModule({ moduleName: 'wishlist', targetDir: tmpRoot });
    const raw = readFileSync(join(outDir, 'sovecom.module.json'), 'utf8');
    const manifest = parseAndVerifyManifest(raw);
    expect(manifest.name).toBe('wishlist');
    expect(() => assertCoreCompatible(manifest)).not.toThrow();
  });

  it('declares only allowlisted permissions', () => {
    const outDir = scaffoldModule({ moduleName: 'wishlist', targetDir: tmpRoot });
    const manifest = parseAndVerifyManifest(
      readFileSync(join(outDir, 'sovecom.module.json'), 'utf8'),
    );
    for (const perm of manifest.permissions) {
      expect(MODULE_PERMISSION_ALLOWLIST as readonly string[]).toContain(perm);
    }
  });

  it('declares tables namespaced to mod_<name>_*', () => {
    const name = 'loyalty';
    const outDir = scaffoldModule({ moduleName: name, targetDir: tmpRoot });
    const manifest = parseAndVerifyManifest(
      readFileSync(join(outDir, 'sovecom.module.json'), 'utf8'),
    );
    expect(manifest.tables ?? []).not.toHaveLength(0);
    for (const table of manifest.tables ?? []) {
      expect(table.startsWith(`mod_${name}_`)).toBe(true);
    }
  });

  it('declares a slot entry the schema accepts', () => {
    const outDir = scaffoldModule({ moduleName: 'wishlist', targetDir: tmpRoot });
    const manifest = parseAndVerifyManifest(
      readFileSync(join(outDir, 'sovecom.module.json'), 'utf8'),
    );
    expect(manifest.slots ?? []).not.toHaveLength(0);
  });

  it('the manifest only declares permissions the starter code actually uses', () => {
    const outDir = scaffoldModule({ moduleName: 'wishlist', targetDir: tmpRoot });
    const manifest = parseAndVerifyManifest(
      readFileSync(join(outDir, 'sovecom.module.json'), 'utf8'),
    );
    const indexSrc = readFileSync(join(outDir, 'src/index.ts'), 'utf8');
    // Map each declared permission to the SDK surface the starter must touch to justify it.
    const usageMarker: Record<string, RegExp> = {
      'read:products': /sdk\.store\.products/,
      'write:own_tables': /sdk\.tables\./,
      'subscribe:events': /sdk\.events\.on/,
    };
    for (const perm of manifest.permissions) {
      const marker = usageMarker[perm];
      expect(marker, `no usage marker registered for declared permission "${perm}"`).toBeDefined();
      expect(marker!.test(indexSrc), `starter does not use declared permission "${perm}"`).toBe(
        true,
      );
    }
  });
});

describe('generated module entry shape', () => {
  it('src/index.ts imports defineModule and exports activate via default', () => {
    const outDir = scaffoldModule({ moduleName: 'wishlist', targetDir: tmpRoot });
    const src = readFileSync(join(outDir, 'src/index.ts'), 'utf8');
    expect(src).toMatch(
      /import\s*\{[^}]*defineModule[^}]*\}\s*from\s*['"]@sovecom\/module-sdk['"]/,
    );
    expect(src).toMatch(/export default defineModule\(/);
    expect(src).toMatch(/activate/);
    // Demonstrates the served-endpoint capability too.
    expect(src).toMatch(/sdk\.serve\(/);
  });

  it('src/db/schema.ts uses createNamespacedTable for a mod_<name>_ table', () => {
    const outDir = scaffoldModule({ moduleName: 'wishlist', targetDir: tmpRoot });
    const src = readFileSync(join(outDir, 'src/db/schema.ts'), 'utf8');
    expect(src).toMatch(/createNamespacedTable\(/);
    expect(src).toMatch(/['"]wishlist['"]/);
  });

  it('generated package.json depends on @sovecom/module-sdk and builds to CJS index.js', () => {
    const outDir = scaffoldModule({ moduleName: 'wishlist', targetDir: tmpRoot });
    const pkg = JSON.parse(readFileSync(join(outDir, 'package.json'), 'utf8')) as {
      name: string;
      main: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('wishlist');
    expect(pkg.dependencies['@sovecom/module-sdk']).toBeDefined();
    expect(pkg.main).toMatch(/index\.js$/);
  });

  it('ships an AGPL-3.0 LICENSE', () => {
    const outDir = scaffoldModule({ moduleName: 'wishlist', targetDir: tmpRoot });
    const license = readFileSync(join(outDir, 'LICENSE'), 'utf8');
    expect(license).toMatch(/GNU AFFERO GENERAL PUBLIC LICENSE/);
  });
});
