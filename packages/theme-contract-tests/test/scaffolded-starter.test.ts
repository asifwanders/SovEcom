import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldTheme } from 'create-sovecom-theme';
import { runThemeContractChecks } from '../src/index.js';

/**
 * The MUST-PASS-CLEAN guarantee: a theme freshly produced by `create-sovecom-theme` passes every
 * HARD contract check with no failures. If the starter and checks ever disagree,
 * this test breaks — the two halves of the theme author toolchain stay in lockstep.
 */
let tmpRoot: string;
let themeDir: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'tct-scaffold-'));
  themeDir = scaffoldTheme({ themeName: 'demo-theme', targetDir: tmpRoot });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('a freshly scaffolded create-sovecom-theme starter', () => {
  it('passes ALL hard contract checks (ok=true)', () => {
    const report = runThemeContractChecks(themeDir);
    const failed = report.checks.filter((c) => c.status === 'fail');
    expect(failed, JSON.stringify(failed, null, 2)).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it('the scaffolded LICENSE is MIT (the load-bearing boundary)', () => {
    const report = runThemeContractChecks(themeDir);
    const lic = report.checks.find((c) => c.id === 'license-mit')!;
    expect(lic.status).toBe('pass');
  });
});
