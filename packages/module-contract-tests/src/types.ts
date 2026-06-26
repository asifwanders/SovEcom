/**
 * the structured result types for the contract-test report.
 *
 * Each check is one of two kinds:
 *  - HARD   (`status` is `'pass'` or `'fail'`): a real, enforceable static guarantee. Any `'fail'`
 *           flips the report's `ok` to false and the CLI exits non-zero.
 *  - ADVISORY (`status` is `'advisory'`): a best-effort heuristic/reminder that CANNOT be proven
 *           statically (migration reversibility, webhook idempotency). It NEVER fails the run and
 * the suite never claims to have verified it.
 */
export type CheckStatus = 'pass' | 'fail' | 'advisory';

export interface CheckResult {
  /** Stable machine id, e.g. `manifest-valid`, `permissions-sufficient`. */
  readonly id: string;
  /** Human-friendly title shown in the CLI. */
  readonly title: string;
  /** `pass`/`fail` for hard checks; `advisory` for the labelled best-effort checks. */
  readonly status: CheckStatus;
  /** Whether this is a hard (enforceable) check or an advisory (heuristic) one. */
  readonly kind: 'hard' | 'advisory';
  /** Diagnostic lines explaining the result (failures list every offending item). */
  readonly messages: string[];
  /** Non-blocking least-privilege / quality hints attached to a passing hard check. */
  readonly advisories: string[];
}

export interface CheckReport {
  /** The validated module directory (absolute). */
  readonly moduleDir: string;
  /** All check results, hard and advisory, in a stable order. */
  readonly checks: CheckResult[];
  /** True iff NO hard check failed. Advisory results never affect this. */
  readonly ok: boolean;
}
