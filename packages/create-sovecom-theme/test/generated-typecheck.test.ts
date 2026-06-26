import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scaffoldTheme } from '../src/scaffold.js';

/**
 * Proves the generated `src/theme.ts` + `src/slots.ts` + `src/settings.ts` actually typecheck
 * against the REAL `@sovecom/theme-sdk` (not just string-matched). We scaffold into a temp dir,
 * link the SDK package (and the transitive deps its source-first `main` pulls in) into the
 * generated theme's node_modules, and run `tsc --noEmit` over the generated tsconfig. No network:
 * we reuse the workspace's own typescript + the in-repo SDK source.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = resolve(here, '..'); // packages/create-sovecom-theme
const repoRoot = resolve(pkgRoot, '..', '..');
const themeSdkDir = resolve(repoRoot, 'packages', 'theme-sdk');
const tscBin = resolve(repoRoot, 'node_modules', '.bin', 'tsc');

let tmpRoot: string;
let outDir: string;

/** Link `<sourcePkg>` into `<nm>/<specifier>`, creating any scope dir. */
function link(nm: string, specifier: string, sourcePkg: string): void {
  const dest = join(nm, specifier);
  mkdirSync(resolve(dest, '..'), { recursive: true });
  symlinkSync(realpathSync(sourcePkg), dest, 'dir');
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cst-tc-'));
  outDir = scaffoldTheme({ themeName: 'aurora', targetDir: tmpRoot });
  // Simulate `pnpm install` in the generated theme: link its declared dep (@sovecom/theme-sdk)
  // and the transitive deps its source-first entry imports (module-sdk, zod, semver, @types/node)
  // so the SDK's `.ts` source typechecks exactly as it would for a real author.
  const nm = join(outDir, 'node_modules');
  mkdirSync(nm, { recursive: true });
  link(nm, join('@sovecom', 'theme-sdk'), themeSdkDir);
  link(nm, join('@sovecom', 'module-sdk'), resolve(repoRoot, 'packages', 'module-sdk'));
  // theme-sdk's own node_modules holds its resolved zod/semver/@types in the pnpm store.
  link(nm, 'zod', resolve(themeSdkDir, 'node_modules', 'zod'));
  link(nm, 'semver', resolve(themeSdkDir, 'node_modules', 'semver'));
  link(nm, join('@types', 'node'), resolve(themeSdkDir, 'node_modules', '@types', 'node'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('generated theme typechecks against @sovecom/theme-sdk', () => {
  it('has tsc available (workspace install present)', () => {
    expect(existsSync(tscBin)).toBe(true);
  });

  it('passes tsc --noEmit', () => {
    // Throws (non-zero exit) if typechecking fails; the thrown stdout/stderr surfaces the error.
    expect(() =>
      execFileSync(tscBin, ['--noEmit', '-p', join(outDir, 'tsconfig.json')], {
        cwd: outDir,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});
