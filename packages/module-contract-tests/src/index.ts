/**
 * `@sovecom/module-contract-tests` — the author-run validator for a SovEcom module directory
 *. Given a module directory (containing `sovecom.module.json`
 * and `src/`), it runs four HARD, enforceable static checks and two clearly-labelled ADVISORY
 * heuristics, returning a structured {@link CheckReport}.
 *
 * It is HONEST by construction: hard checks REUSE the SDK's own validators (`parseAndVerifyManifest`,
 * `assertCoreCompatible`) and permission allowlist — there is exactly one definition of every
 * contract rule — and advisory checks never claim to have proven what they cannot.
 *
 * Run it programmatically (`runContractChecks(dir)`) or via the `module-contract-tests` CLI.
 */
import { resolve } from 'node:path';
import {
  loadManifest,
  scanModuleUsage,
  checkManifestValid,
  checkTablesNamespaced,
  checkPermissionsSufficient,
  checkCoreVersionCompatible,
  advisoryMigrationReversibility,
  advisoryWebhookIdempotency,
} from './checks.js';
import type { CheckReport, CheckResult } from './types.js';

export type { CheckReport, CheckResult, CheckStatus } from './types.js';
export { MODULE_PERMISSION_ALLOWLIST } from './checks.js';

/** Package version (independent of the core API contract version). */
export const CONTRACT_TESTS_VERSION = '0.0.1';

/**
 * Run all contract checks against `moduleDir`. Pure read-only static analysis: it reads files and
 * parses the manifest + source AST; it NEVER executes the module's code, runs migrations, or
 * touches a database. Returns a {@link CheckReport}; `ok` is true iff no HARD check failed
 * (advisory results never affect `ok`).
 */
export function runContractChecks(moduleDir: string): CheckReport {
  const dir = resolve(moduleDir);
  const load = loadManifest(dir);
  const usage = scanModuleUsage(dir);

  const checks: CheckResult[] = [
    checkManifestValid(load),
    checkTablesNamespaced(dir, load, usage),
    checkPermissionsSufficient(load, usage),
    checkCoreVersionCompatible(load),
    advisoryMigrationReversibility(usage),
    advisoryWebhookIdempotency(usage),
  ];

  const ok = checks.every((c) => c.kind !== 'hard' || c.status !== 'fail');
  return { moduleDir: dir, checks, ok };
}
