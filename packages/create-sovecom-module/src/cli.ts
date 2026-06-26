#!/usr/bin/env node
/**
 * the non-interactive CLI entrypoint.
 *
 *   create-sovecom-module <module-name> [--dir <path>]
 *
 * Built on Node built-ins ONLY: `node:util` parseArgs for flags. No commander/yargs/prompts/
 * inquirer; no interactive prompts. `runCli` is pure (returns an exit code, takes injectable I/O)
 * so it is unit-testable; the bottom-of-file bootstrap wires real argv + process.exit.
 */
import { parseArgs } from 'node:util';
import { scaffoldModule, InvalidModuleNameError } from './scaffold.js';

const USAGE = 'usage: create-sovecom-module <module-name> [--dir <path>]';

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
    io.err(`error: missing required <module-name>\n${USAGE}`);
    return 1;
  }
  if (positionals.length > 1) {
    io.err(`error: unexpected extra arguments: ${positionals.slice(1).join(' ')}\n${USAGE}`);
    return 1;
  }

  const moduleName = positionals[0]!;
  const targetDir = values.dir ?? cwd;

  try {
    const outDir = scaffoldModule({ moduleName, targetDir });
    io.log(`Created SovEcom module starter at ${outDir}`);
    io.log('Next steps:');
    io.log(`  cd ${moduleName}`);
    io.log('  pnpm install');
    io.log('  pnpm build');
    return 0;
  } catch (error) {
    if (error instanceof InvalidModuleNameError) {
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
