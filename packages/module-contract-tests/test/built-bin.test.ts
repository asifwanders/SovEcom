import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scaffoldModule } from 'create-sovecom-module';

/**
 * BUILT-BIN GUARD (the chunk-B lesson). The in-repo vitest/tsc tests all run through the TS
 * toolchain and resolve `@sovecom/module-sdk` to its source `src/index.ts`. The EMITTED bin runs
 * under plain `node`, where that bare specifier resolves to raw `.ts` the runtime cannot load.
 * This test compiles BOTH this package and the SDK, then runs the real `dist/cli.js` under plain
 * `node` against a scaffolded module — exactly as CI / an end user / the 3.19 publish would —
 * asserting exit 0 on a clean module and a non-zero exit on a broken one.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = resolve(here, '..'); // packages/module-contract-tests
const repoRoot = resolve(pkgRoot, '..', '..');
const tscBin = resolve(repoRoot, 'node_modules', '.bin', 'tsc');
const sdkRoot = resolve(repoRoot, 'packages', 'module-sdk');
const builtCli = join(pkgRoot, 'dist', 'cli.js');

let tmpRoot: string;

beforeAll(() => {
  // Build the SDK (so dist/index.js exists for the bin to load) and this package's bin.
  execFileSync(tscBin, ['-p', join(sdkRoot, 'tsconfig.json')], { cwd: sdkRoot, stdio: 'pipe' });
  execFileSync(tscBin, ['-p', join(pkgRoot, 'tsconfig.json')], { cwd: pkgRoot, stdio: 'pipe' });
  tmpRoot = mkdtempSync(join(tmpdir(), 'mct-bin-'));
}, 120_000); // two full tsc builds — well past vitest's default 10s hook timeout on CI runners

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the compiled bin runs under plain node', () => {
  it('built the bin', () => {
    expect(existsSync(builtCli)).toBe(true);
  });

  it('runs `node dist/cli.js <clean-module>` with exit 0 and prints PASS', () => {
    const moduleDir = scaffoldModule({ moduleName: 'bin-clean', targetDir: tmpRoot });
    // execFileSync throws on a non-zero exit; reaching the assertions means exit 0.
    const stdout = execFileSync(process.execPath, [builtCli, moduleDir], {
      stdio: 'pipe',
    }).toString();
    expect(stdout).toMatch(/PASS/);
  });

  it('exits non-zero on a broken module (non-namespaced table)', () => {
    const moduleDir = scaffoldModule({ moduleName: 'bin-broken', targetDir: tmpRoot });
    // Overwrite the manifest with a non-namespaced table to force a hard failure.
    const badManifest = JSON.stringify(
      {
        name: 'bin-broken',
        displayName: 'bin-broken',
        version: '0.1.0',
        compatibleCore: '^1.0.0',
        permissions: [],
        tables: ['orders'],
      },
      null,
      2,
    );
    writeFileSync(join(moduleDir, 'sovecom.module.json'), badManifest, 'utf8');

    let code = 0;
    try {
      execFileSync(process.execPath, [builtCli, moduleDir], { stdio: 'pipe' });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    expect(code).not.toBe(0);
  });
});
