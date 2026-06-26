#!/usr/bin/env node
/**
 * the non-interactive CLI entrypoint.
 *
 *   create-sovecom-theme <theme-name> [--dir <path>]
 *
 * Built on Node built-ins ONLY: `node:util` parseArgs for flags. No commander/yargs/prompts/
 * inquirer; no interactive prompts. `runCli` is pure (returns an exit code, takes injectable I/O)
 * so it is unit-testable; the bottom-of-file bootstrap wires real argv + process.exit.
 *
 * The bin has ZERO `@sovecom/theme-sdk` runtime import — the only SDK rule it needs (the theme-name
 * slug) is carried locally in `theme-name.ts` and drift-guarded by a conformance test. This is the
 * Decision-052 lesson applied from the start: the SDK is source-first, so the emitted bin must not
 * depend on it at runtime.
 */
import { parseArgs } from 'node:util';
import { scaffoldTheme, InvalidThemeNameError } from './scaffold.js';

const USAGE = 'usage: create-sovecom-theme <theme-name> [--dir <path>]';

export interface CliIo {
  log: (message: string) => void;
  err: (message: string) => void;
  /** Base directory for a relative/omitted `--dir`. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Parse argv (after `node script.js`) and scaffold. Returns a process exit code: 0 on success,
 * 1 on a usage/validation/IO error. Never calls process.exit itself.
 */
export function runCli(argv: readonly string[], io: CliIo): number {
  const cwd = io.cwd ?? process.cwd();

  let positionals: string[];
  let values: { dir?: string; help?: boolean };
  try {
    const parsed = parseArgs({
      args: argv as string[],
      allowPositionals: true,
      options: {
        dir: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
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
    io.err(`error: missing required <theme-name>\n${USAGE}`);
    return 1;
  }
  if (positionals.length > 1) {
    io.err(`error: unexpected extra arguments: ${positionals.slice(1).join(' ')}\n${USAGE}`);
    return 1;
  }

  const themeName = positionals[0]!;
  const targetDir = values.dir ?? cwd;

  try {
    const outDir = scaffoldTheme({ themeName, targetDir });
    io.log(`Created SovEcom theme starter at ${outDir}`);
    io.log('Next steps:');
    io.log(`  cd ${themeName}`);
    io.log('  pnpm install');
    io.log('  pnpm typecheck');
    return 0;
  } catch (error) {
    if (error instanceof InvalidThemeNameError) {
      io.err(`error: ${error.message}`);
      return 1;
    }
    io.err(`error: ${(error as Error).message}`);
    return 1;
  }
}

/* istanbul ignore next — the real-process bootstrap is exercised by the end-to-end CLI run. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const code = runCli(process.argv.slice(2), {
    // eslint-disable-next-line no-console
    log: (m) => console.log(m),
    // eslint-disable-next-line no-console
    err: (m) => console.error(m),
  });
  process.exit(code);
}
