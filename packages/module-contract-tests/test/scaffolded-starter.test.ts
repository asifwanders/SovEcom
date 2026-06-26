import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldModule } from 'create-sovecom-module';
import { runContractChecks } from '../src/index.js';

/**
 * The MUST-PASS-CLEAN guarantee: a module freshly produced by `create-sovecom-module` passes every
 * HARD contract check with no failures. If the starter and checks ever disagree,
 * this test breaks — the two halves of the author toolchain stay in lockstep.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
void repoRoot;

let tmpRoot: string;
let moduleDir: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mct-scaffold-'));
  moduleDir = scaffoldModule({ moduleName: 'demo-widget', targetDir: tmpRoot });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('a freshly scaffolded create-sovecom-module starter', () => {
  it('passes ALL hard contract checks (ok=true)', () => {
    const report = runContractChecks(moduleDir);
    const failed = report.checks.filter((c) => c.status === 'fail');
    expect(failed, JSON.stringify(failed, null, 2)).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it('the starter declares exactly the permissions it uses (no missing, no surplus advisory)', () => {
    const report = runContractChecks(moduleDir);
    const perms = report.checks.find((c) => c.id === 'permissions-sufficient')!;
    expect(perms.status).toBe('pass');
    expect(perms.advisories, JSON.stringify(perms.advisories)).toHaveLength(0);
  });
});
