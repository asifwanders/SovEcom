import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scaffoldModule } from '../src/scaffold.js';

/**
 * Proves the generated `src/index.ts` + `src/db/schema.ts` actually typecheck against the REAL
 * `@sovecom/module-sdk` (not just string-matched). We scaffold into a temp dir, link the SDK
 * package into the generated module's node_modules, and run `tsc --noEmit` over the generated
 * tsconfig. No network: we reuse the workspace's own typescript + the in-repo SDK source.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = resolve(here, '..'); // packages/create-sovecom-module
const repoRoot = resolve(pkgRoot, '..', '..');
const sdkPkgDir = resolve(repoRoot, 'packages', 'module-sdk');
const tscBin = resolve(repoRoot, 'node_modules', '.bin', 'tsc');

let tmpRoot: string;
let outDir: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'csm-tc-'));
  outDir = scaffoldModule({ moduleName: 'wishlist', targetDir: tmpRoot });
  // Simulate `pnpm install` in the generated module: link its declared deps into node_modules so
  // imports + ambient Node types resolve exactly as they would for a real author.
  const nm = join(outDir, 'node_modules');
  mkdirSync(join(nm, '@sovecom'), { recursive: true });
  symlinkSync(sdkPkgDir, join(nm, '@sovecom', 'module-sdk'), 'dir');
  // @types/node (devDependency of the generated package.json) — resolve the real path via the
  // SDK's own node_modules (pnpm keeps it in the store, not hoisted to the repo-root @types).
  const nodeTypes = realpathSync(resolve(sdkPkgDir, 'node_modules', '@types', 'node'));
  mkdirSync(join(nm, '@types'), { recursive: true });
  symlinkSync(nodeTypes, join(nm, '@types', 'node'), 'dir');
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('generated module typechecks against @sovecom/module-sdk', () => {
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
