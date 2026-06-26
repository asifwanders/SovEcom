import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseAndVerifyManifest } from '@sovecom/module-sdk';

/**
 * BUILT-BIN GUARD. The blocker this test exists for: `node dist/cli.js` crashed with
 * ERR_MODULE_NOT_FOUND because the compiled bin still carried a runtime
 * `import { MODULE_NAME_RE } from '@sovecom/module-sdk'`, and the SDK ships source-first so plain
 * node could not load it. The in-repo vitest/tsc tests all run through the TS toolchain and never
 * exercise the emitted bin, so they passed while the real `bin` was broken.
 *
 * This test compiles the package (`tsc -p tsconfig.json`) and then runs the EMITTED
 * `dist/cli.js` under plain `node` (process.execPath), exactly as an end user / CI / the 3.19
 * publish would. It asserts: exit 0, the module tree was created, and the generated
 * `sovecom.module.json` passes the SDK's `parseAndVerifyManifest`.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = resolve(here, '..'); // packages/create-sovecom-module
const repoRoot = resolve(pkgRoot, '..', '..');
const tscBin = resolve(repoRoot, 'node_modules', '.bin', 'tsc');
const builtCli = join(pkgRoot, 'dist', 'cli.js');

let tmpRoot: string;

beforeAll(() => {
  // Build the package so we exercise the REAL emitted bin, not the TS source.
  execFileSync(tscBin, ['-p', join(pkgRoot, 'tsconfig.json')], { cwd: pkgRoot, stdio: 'pipe' });
  tmpRoot = mkdtempSync(join(tmpdir(), 'csm-bin-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  // dist is gitignored build output; leave it (other consumers may want it) — the build is cheap.
});

describe('the compiled bin runs under plain node', () => {
  it('built the bin', () => {
    expect(existsSync(builtCli)).toBe(true);
  });

  it('runs `node dist/cli.js demo-widget --dir <tmp>` with exit 0 and creates the tree', () => {
    // execFileSync throws on a non-zero exit; reaching the assertions means exit 0.
    const stdout = execFileSync(process.execPath, [builtCli, 'demo-widget', '--dir', tmpRoot], {
      stdio: 'pipe',
    }).toString();

    expect(stdout).toMatch(/Created SovEcom module starter/);

    const outDir = join(tmpRoot, 'demo-widget');
    expect(existsSync(join(outDir, 'package.json'))).toBe(true);
    expect(existsSync(join(outDir, 'sovecom.module.json'))).toBe(true);
  });

  it('produces a manifest that passes the SDK parseAndVerifyManifest', () => {
    const manifestRaw = readFileSync(join(tmpRoot, 'demo-widget', 'sovecom.module.json'), 'utf8');
    const manifest = parseAndVerifyManifest(manifestRaw);
    expect(manifest.name).toBe('demo-widget');
  });
});
