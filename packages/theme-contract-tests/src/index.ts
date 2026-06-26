/**
 * `@sovecom/theme-contract-tests` — the author-run validator for a SovEcom THEME directory.
 * Given a theme directory (containing `sovecom.theme.json` and a
 * `LICENSE`), it runs four HARD, enforceable static checks and returns a structured
 * {@link CheckReport}.
 *
 * A theme is a declarative ASSET: NO code, NO permissions, NO namespaced
 * tables. So — unlike the module contract-tests — there is NO permission-sufficiency
 * check, NO source-AST scan, and NO advisory heuristics: every check is hard.
 *
 * It is HONEST by construction: the manifest/core/slot checks REUSE the theme SDK's own validators
 * (`parseAndVerifyThemeManifest`, `assertCoreCompatible`, `SLOT_SLUG_RE`) — there is exactly one
 * definition of every contract rule. The fourth check enforces the MIT license
 * boundary. It NEVER executes theme code (a theme has none).
 *
 * Run it programmatically (`runThemeContractChecks(dir)`) or via the `theme-contract-tests` CLI.
 */
import { resolve } from 'node:path';
import {
  loadManifest,
  checkManifestValid,
  checkCoreVersionCompatible,
  checkSlotsValid,
  checkLicenseMit,
} from './checks.js';
import type { CheckReport, CheckResult } from './types.js';

export type { CheckReport, CheckResult, CheckStatus } from './types.js';
export { SLOT_SLUG_RE } from './checks.js';

/** Package version (independent of the core API contract version). */
export const THEME_CONTRACT_TESTS_VERSION = '0.0.1';

/**
 * Run all theme contract checks against `themeDir`. Pure read-only static analysis: it reads the
 * manifest and the LICENSE file; it NEVER executes code (a theme has none), runs migrations, or
 * touches a database. Returns a {@link CheckReport}; `ok` is true iff no HARD check failed.
 */
export function runThemeContractChecks(themeDir: string): CheckReport {
  const dir = resolve(themeDir);
  const load = loadManifest(dir);

  const checks: CheckResult[] = [
    checkManifestValid(load),
    checkCoreVersionCompatible(load),
    checkSlotsValid(load),
    checkLicenseMit(dir),
  ];

  const ok = checks.every((c) => c.kind !== 'hard' || c.status !== 'fail');
  return { themeDir: dir, checks, ok };
}
