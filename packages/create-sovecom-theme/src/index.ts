/**
 * Public surface of the `create-sovecom-theme` scaffolder for programmatic consumers.
 * The CLI bin lives in `cli.ts`.
 */
export { scaffoldTheme, assertValidThemeName, InvalidThemeNameError } from './scaffold.js';
export type { ScaffoldOptions } from './scaffold.js';
export { runCli } from './cli.js';
export type { CliIo } from './cli.js';
export { THEME_NAME_RE } from './theme-name.js';
