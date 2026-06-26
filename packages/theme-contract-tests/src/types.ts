/**
 * the structured result types for the theme contract-test report.
 *
 * A theme is a declarative ASSET: it has NO code, NO permissions, and NO
 * namespaced tables. So — unlike the module contract-tests — there are NO advisory
 * heuristics here: every check is HARD and enforceable. A `'fail'` flips the report's `ok` to false
 * and the CLI exits non-zero. The `advisory` status is kept in the union (and `advisories` on the
 * result) so the report shape stays recognisably the same as the module sibling, but the theme
 * checks never emit one.
 */
export type CheckStatus = 'pass' | 'fail' | 'advisory';

export interface CheckResult {
  /** Stable machine id, e.g. `manifest-valid`, `license-mit`. */
  readonly id: string;
  /** Human-friendly title shown in the CLI. */
  readonly title: string;
  /** `pass`/`fail` for hard checks; `advisory` for any best-effort check (themes use none). */
  readonly status: CheckStatus;
  /** Whether this is a hard (enforceable) check or an advisory (heuristic) one. */
  readonly kind: 'hard' | 'advisory';
  /** Diagnostic lines explaining the result (failures list every offending item). */
  readonly messages: string[];
  /** Non-blocking quality hints attached to a passing hard check. */
  readonly advisories: string[];
}

export interface CheckReport {
  /** The validated theme directory (absolute). */
  readonly themeDir: string;
  /** All check results, in a stable order. */
  readonly checks: CheckResult[];
  /** True iff NO hard check failed. Advisory results never affect this. */
  readonly ok: boolean;
}
