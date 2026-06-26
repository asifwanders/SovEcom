import { describe, it, expect, afterEach } from 'vitest';
import { runCli } from '../src/cli.js';
import { makeModuleDir, defaultManifest, cleanupFixtures } from './fixtures.js';

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
  it('exits 0 and prints PASS for a clean module', () => {
    const dir = makeModuleDir({ manifest: defaultManifest('demo') });
    const cap = capture();
    const code = runCli([dir], cap.io);
    expect(code).toBe(0);
    expect(cap.out.join('\n')).toMatch(/PASS/);
  });

  it('exits non-zero when a hard check fails', () => {
    const dir = makeModuleDir({ manifest: defaultManifest('demo', { tables: ['orders'] }) });
    const cap = capture();
    const code = runCli([dir], cap.io);
    expect(code).toBe(1);
    expect(cap.out.join('\n') + cap.err.join('\n')).toMatch(/FAIL/);
  });

  it('exit 0 even when only advisory notes are present (advisory never fails the run)', () => {
    const dir = makeModuleDir({ manifest: defaultManifest('demo') });
    const cap = capture();
    const code = runCli([dir], cap.io);
    expect(code).toBe(0);
    expect(cap.out.join('\n')).toMatch(/ADVISORY/);
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

  it('exits 1 with a manifest FAIL when the target directory has no manifest', () => {
    const cap = capture();
    const code = runCli(['/no/such/module/dir/at/all'], cap.io);
    expect(code).toBe(1);
    // A missing dir => no sovecom.module.json => the manifest hard check fails (honest result),
    // not a CLI usage error.
    expect(cap.out.join('\n')).toMatch(/FAIL/);
    expect(cap.err.join('\n')).toMatch(/Result: FAIL/);
  });
});
