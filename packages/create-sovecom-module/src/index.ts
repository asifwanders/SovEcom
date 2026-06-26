/**
 * `create-sovecom-module` — non-interactive scaffolder for a SovEcom module starter
 *. Private/in-repo; consumed via the pnpm workspace. The
 * runnable entrypoint is `cli.ts` (the package `bin`); this module re-exports the programmatic
 * API for tests and embedders.
 */
export { scaffoldModule, assertValidModuleName, InvalidModuleNameError } from './scaffold.js';
export type { ScaffoldOptions } from './scaffold.js';
export { runCli } from './cli.js';
export type { CliIo } from './cli.js';
