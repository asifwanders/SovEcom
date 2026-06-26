import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

/**
 * The thin argv layer: parses `<theme-name> [--dir <path>]` with node:util parseArgs and returns
 * a numeric exit code (0 ok, non-zero on error). It must NOT call process.exit itself — that stays
 * in the bin shebang wrapper — so it is unit-testable here.
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cst-cli-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function silentLog(): { log: (m: string) => void; err: (m: string) => void; errors: string[] } {
  const errors: string[] = [];
  return { log: () => {}, err: (m: string) => errors.push(m), errors };
}

describe('runCli', () => {
  it('exits non-zero when no theme name is given', () => {
    const io = silentLog();
    const code = runCli([], { log: io.log, err: io.err });
    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toMatch(/theme-name/i);
  });

  it('exits non-zero on an invalid theme name', () => {
    const io = silentLog();
    const code = runCli(['Bad Name', '--dir', tmpRoot], { log: io.log, err: io.err });
    expect(code).not.toBe(0);
    expect(io.errors.join('\n')).toMatch(/lowercase slug|invalid/i);
  });

  it('scaffolds into --dir and exits 0 on a valid name', () => {
    const io = silentLog();
    const code = runCli(['aurora', '--dir', tmpRoot], { log: io.log, err: io.err });
    expect(code).toBe(0);
    expect(existsSync(join(tmpRoot, 'aurora', 'sovecom.theme.json'))).toBe(true);
  });

  it('defaults the directory to the current working dir when --dir is omitted', () => {
    const io = silentLog();
    const code = runCli(['aurora'], { log: io.log, err: io.err, cwd: tmpRoot });
    expect(code).toBe(0);
    expect(existsSync(join(tmpRoot, 'aurora', 'package.json'))).toBe(true);
  });

  it('exits non-zero on an unknown flag', () => {
    const io = silentLog();
    const code = runCli(['aurora', '--frobnicate'], { log: io.log, err: io.err, cwd: tmpRoot });
    expect(code).not.toBe(0);
  });
});
