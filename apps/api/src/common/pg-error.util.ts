/**
 * Postgres error helpers.
 *
 * The `postgres` (postgres-js) driver surfaces server errors with a SQLSTATE
 * `code` string. `23505` is `unique_violation`. Use this to convert a lost
 * INSERT race on a UNIQUE constraint into a clean 409 instead of a 500.
 */

/** SQLSTATE for a unique-constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505';
/** SQLSTATE for a foreign-key violation. */
export const PG_FOREIGN_KEY_VIOLATION = '23503';

/** Extract a SQLSTATE `code` from a raw pg error OR a drizzle-wrapped one. */
function pgErrorCode(err: unknown): unknown {
  if (typeof err !== 'object' || err === null) return undefined;
  // Raw postgres-js error: `code` is at the top level.
  if ('code' in err && (err as { code?: unknown }).code !== undefined) {
    return (err as { code?: unknown }).code;
  }
  // Drizzle wraps driver errors in DrizzleQueryError ("Failed query: …") and
  // hangs the original pg error (with its SQLSTATE) off `.cause`. Unwrap one level.
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    return (cause as { code?: unknown }).code;
  }
  return undefined;
}

/** True when `err` is a Postgres unique-constraint violation (SQLSTATE 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_UNIQUE_VIOLATION;
}

/** True when `err` is a Postgres foreign-key violation (SQLSTATE 23503). */
export function isForeignKeyViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_FOREIGN_KEY_VIOLATION;
}
