#!/usr/bin/env node
/**
 * the non-interactive CLI entrypoint.
 *
 *   theme-contract-tests <theme-dir>
 *
 * Built on Node built-ins ONLY: `node:util` parseArgs for flags. No commander/yargs/prompts. It
 * runs the theme contract checks against the given directory, prints a per-check PASS/FAIL report,
 * and exits NON-ZERO iff any HARD check failed. `runCli` is pure (returns an exit code, takes
 * injectable I/O) so it is unit-testable; the bottom-of-file bootstrap wires real argv +
 * process.exit.
 */
import { parseArgs } from 'node:util';
import { runThemeContractChecks } from './index.js';

const USAGE = 'usage: theme-contract-tests <theme-dir>';

export interface CliIo {
  log: (message: string) => void;
  err: (message: string) => void;
}

/**
 * Parse argv (after `node script.js`) and validate the theme dir. Returns a process exit code:
 * 0 when all hard checks pass, 1 on any hard failure or a usage error. Never calls process.exit
 * itself.
 */
export function runCli(argv: readonly string[], io: CliIo): number {
  let positionals: string[];
  let values: { help?: boolean };
  try {
    const parsed = parseArgs({
      args: argv as string[],
      allowPositionals: true,
      options: { help: { type: 'boolean', short: 'h' } },
    });
    positionals = parsed.positionals;
    values = parsed.values;
  } catch (error) {
    io.err(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }

  if (values.help) {
    io.log(USAGE);
    return 0;
  }
  if (positionals.length === 0) {
    io.err(`error: missing required <theme-dir>\n${USAGE}`);
    return 1;
  }
  if (positionals.length > 1) {
    io.err(`error: unexpected extra arguments: ${positionals.slice(1).join(' ')}\n${USAGE}`);
    return 1;
  }

  const themeDir = positionals[0]!;

  let report: ReturnType<typeof runThemeContractChecks>;
  try {
    report = runThemeContractChecks(themeDir);
  } catch (error) {
    io.err(`error: ${(error as Error).message}`);
    return 1;
  }

  io.log(`SovEcom theme contract checks — ${report.themeDir}\n`);
  for (const check of report.checks) {
    const label = check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : 'ADVISORY';
    io.log(`[${label}] ${check.title}`);
    for (const m of check.messages) io.log(`        ${m}`);
    for (const a of check.advisories) io.log(`        (advisory) ${a}`);
  }

  io.log('');
  if (report.ok) {
    io.log('Result: PASS — all hard checks passed.');
    return 0;
  }
  io.err('Result: FAIL — one or more hard checks failed. Fix them before publishing.');
  return 1;
}

/* istanbul ignore next — the real-process bootstrap is exercised by the built-bin end-to-end test. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const code = runCli(process.argv.slice(2), {
    // eslint-disable-next-line no-console
    log: (m) => console.log(m),
    // eslint-disable-next-line no-console
    err: (m) => console.error(m),
  });
  process.exit(code);
}
