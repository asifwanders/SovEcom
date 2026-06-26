import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAndVerifyThemeManifest } from '@sovecom/theme-sdk';

/**
 * Built-bin guard. This test prevents a compiled binary that still imports
 * `THEME_NAME_RE` from `@sovecom/theme-sdk` from crashing under plain node (the SDK ships
 * source-first, so node cannot load raw TypeScript). In-repo vitest/tsc tests run through the TS
 * toolchain and never exercise the emitted binary, so they could pass while the real binary is broken.
 *
 * This test compiles the package (`tsc -p tsconfig.json`) and then runs the EMITTED `dist/cli.js`
 * under plain `node` (process.execPath), exactly as an end user / CI / the 3.19 publish would. It
 * asserts: exit 0, the theme tree was created, and the generated `sovecom.theme.json` passes the
 * SDK's `parseAndVerifyThemeManifest`.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = resolve(here, '..'); // packages/create-sovecom-theme
const repoRoot = resolve(pkgRoot, '..', '..');
const tscBin = resolve(repoRoot, 'node_modules', '.bin', 'tsc');
const builtCli = join(pkgRoot, 'dist', 'cli.js');

let tmpRoot: string;

beforeAll(() => {
  // Build the package so we exercise the REAL emitted bin, not the TS source.
  execFileSync(tscBin, ['-p', join(pkgRoot, 'tsconfig.json')], { cwd: pkgRoot, stdio: 'pipe' });
  tmpRoot = mkdtempSync(join(tmpdir(), 'cst-bin-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  // dist is gitignored build output; leave it — the build is cheap.
});

describe('the compiled bin runs under plain node', () => {
  it('built the bin', () => {
    expect(existsSync(builtCli)).toBe(true);
  });

  it('the emitted bin has NO @sovecom/theme-sdk runtime import', () => {
    const emitted = readFileSync(builtCli, 'utf8');
    // Match an actual import/require — not a mention in a doc comment. The whole Decision-052
    // point is that the bin must not LOAD the source-first SDK at runtime.
    expect(emitted).not.toMatch(/require\(\s*['"]@sovecom\/theme-sdk['"]\s*\)/);
    expect(emitted).not.toMatch(/\bfrom\s+['"]@sovecom\/theme-sdk['"]/);
    expect(emitted).not.toMatch(/\bimport\(\s*['"]@sovecom\/theme-sdk['"]\s*\)/);
  });

  it('runs `node dist/cli.js demo-theme --dir <tmp>` with exit 0 and creates the tree', () => {
    // execFileSync throws on a non-zero exit; reaching the assertions means exit 0.
    const stdout = execFileSync(process.execPath, [builtCli, 'demo-theme', '--dir', tmpRoot], {
      stdio: 'pipe',
    }).toString();

    expect(stdout).toMatch(/Created SovEcom theme starter/);

    const outDir = join(tmpRoot, 'demo-theme');
    expect(existsSync(join(outDir, 'package.json'))).toBe(true);
    expect(existsSync(join(outDir, 'sovecom.theme.json'))).toBe(true);
  });

  it('produces a manifest that passes the SDK parseAndVerifyThemeManifest', () => {
    const manifestRaw = readFileSync(join(tmpRoot, 'demo-theme', 'sovecom.theme.json'), 'utf8');
    const manifest = parseAndVerifyThemeManifest(manifestRaw);
    expect(manifest.name).toBe('demo-theme');
  });
});
