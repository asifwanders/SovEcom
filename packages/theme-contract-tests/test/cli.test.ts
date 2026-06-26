import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../src/cli.js';
import { makeThemeDir, defaultManifest, cleanupFixtures, AGPL_LICENSE } from './fixtures.js';

afterEach(() => cleanupFixtures());

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { log: (m: string) => out.push(m), err: (m: string) => err.push(m) },
    out,
    err,
  };
}

describe('runCli', () => {
  it('exits 0 and prints PASS for a clean theme', () => {
    const dir = makeThemeDir({ manifest: defaultManifest('demo') });
    const cap = capture();
    const code = runCli([dir], cap.io);
    expect(code).toBe(0);
    expect(cap.out.join('\n')).toMatch(/PASS/);
  });

  it('exits non-zero when a hard check fails (non-MIT license)', () => {
    const dir = makeThemeDir({ manifest: defaultManifest('demo'), license: AGPL_LICENSE });
    const cap = capture();
    const code = runCli([dir], cap.io);
    expect(code).toBe(1);
    expect(cap.out.join('\n') + cap.err.join('\n')).toMatch(/FAIL/);
  });

  it('exits 1 with usage on a missing directory argument', () => {
    const cap = capture();
    const code = runCli([], cap.io);
    expect(code).toBe(1);
    expect(cap.err.join('\n')).toMatch(/usage:/);
  });

  it('prints usage on --help and exits 0', () => {
    const cap = capture();
    const code = runCli(['--help'], cap.io);
    expect(code).toBe(0);
    expect(cap.out.join('\n')).toMatch(/usage:/);
  });

  it('exits 1 with extra positional arguments', () => {
    const cap = capture();
    const code = runCli(['a', 'b'], cap.io);
    expect(code).toBe(1);
    expect(cap.err.join('\n')).toMatch(/unexpected extra arguments/);
  });

  it('exits 1 with a manifest FAIL when the target directory has no manifest', () => {
    const cap = capture();
    const code = runCli(['/no/such/theme/dir/at/all'], cap.io);
    expect(code).toBe(1);
    // A missing dir => no sovecom.theme.json => the manifest hard check fails (honest result),
    // not a CLI usage error.
    expect(cap.out.join('\n')).toMatch(/FAIL/);
    expect(cap.err.join('\n')).toMatch(/Result: FAIL/);
  });
});
