import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scaffoldTheme } from 'create-sovecom-theme';

/**
 * BUILT-BIN GUARD. The in-repo vitest/tsc tests all run through the TS toolchain and resolve
 * `@sovecom/theme-sdk` to its source `src/index.ts`. The EMITTED bin runs under plain `node`,
 * where that bare specifier resolves to raw `.ts` the runtime cannot load. This test compiles BOTH
 * this package and the SDK, then runs the real `dist/cli.js` under plain `node` against a
 * scaffolded theme — exactly as CI / an end user / a publish would — asserting exit 0 on a clean
 * theme and a non-zero exit on a broken one.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = resolve(here, '..'); // packages/theme-contract-tests
const repoRoot = resolve(pkgRoot, '..', '..');
const tscBin = resolve(repoRoot, 'node_modules', '.bin', 'tsc');
const sdkRoot = resolve(repoRoot, 'packages', 'theme-sdk');
const builtCli = join(pkgRoot, 'dist', 'cli.js');

let tmpRoot: string;

beforeAll(() => {
  // Build the SDK (so dist/index.js exists for the bin to load) and this package's bin.
  execFileSync(tscBin, ['-p', join(sdkRoot, 'tsconfig.json')], { cwd: sdkRoot, stdio: 'pipe' });
  execFileSync(tscBin, ['-p', join(pkgRoot, 'tsconfig.json')], { cwd: pkgRoot, stdio: 'pipe' });
  tmpRoot = mkdtempSync(join(tmpdir(), 'tct-bin-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the compiled bin runs under plain node', () => {
  it('built the bin', () => {
    expect(existsSync(builtCli)).toBe(true);
  });

  it('runs `node dist/cli.js <clean-theme>` with exit 0 and prints PASS', () => {
    const themeDir = scaffoldTheme({ themeName: 'bin-clean', targetDir: tmpRoot });
    // execFileSync throws on a non-zero exit; reaching the assertions means exit 0.
    const stdout = execFileSync(process.execPath, [builtCli, themeDir], {
      stdio: 'pipe',
    }).toString();
    expect(stdout).toMatch(/PASS/);
  });

  it('exits non-zero on a broken theme (AGPL license, not MIT)', () => {
    const themeDir = scaffoldTheme({ themeName: 'bin-broken', targetDir: tmpRoot });
    // Overwrite the LICENSE with the AGPL text to force the MIT hard check to fail.
    writeFileSync(
      join(themeDir, 'LICENSE'),
      '                    GNU AFFERO GENERAL PUBLIC LICENSE\n' +
        '                       Version 3, 19 November 2007\n',
      'utf8',
    );

    let code = 0;
    try {
      execFileSync(process.execPath, [builtCli, themeDir], { stdio: 'pipe' });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    expect(code).not.toBe(0);
  });
});
