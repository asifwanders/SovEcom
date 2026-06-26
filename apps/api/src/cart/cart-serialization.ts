/**
 * Cart (de)serialization & Redis-EXEC plumbing.
 *
 * Pure helpers extracted from {@link CartRepository} (no class state): the JSON
 * date-revival of a persisted cart blob, the MULTI/EXEC success assertion, and the
 * randomised-backoff sleep used by the optimistic retry loop. Kept in one module so
 * the serialization contract and the WATCH/EXEC failure semantics live together and
 * can be unit-tested independent of the repository.
 */
import type { CartState, CartLineItem } from './cart.types';

/** Redis TTL: 8 days (guest carts expire after 7 days; the TTL adds a 1-day buffer). */
export const REDIS_TTL_SECONDS = 8 * 24 * 60 * 60; // 8 days

/** JSON date fields that need to be revived as Date objects. */
const DATE_FIELDS: Array<keyof CartState> = ['expiresAt', 'createdAt', 'updatedAt'];

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A non-null MULTI/EXEC result whose queued commands all succeeded. ioredis returns
 * `null` only on a WATCH abort; a per-command failure (e.g. SETEX rejected under
 * `maxmemory noeviction`) comes back as an `[err, reply]` tuple in a NON-null array.
 * Treating that array as success would silently lose the write — so any tuple with a
 * non-null error throws (review S-3).
 */
export function assertExecOk(execResult: [Error | null, unknown][] | null): void {
  if (execResult === null) return; // WATCH abort — caller handles the retry
  for (const [err] of execResult) {
    if (err != null) {
      throw err;
    }
  }
}

/** Exported for CartFlushRepository's still-current check on the flushed blob. */
export function reviveCartState(raw: unknown): CartState {
  return revive(raw);
}

export function revive(raw: unknown): CartState {
  const state = raw as CartState & Record<string, unknown>;
  for (const f of DATE_FIELDS) {
    if (typeof state[f] === 'string') {
      (state as Record<string, unknown>)[f] = new Date(state[f] as string);
    }
  }
  // Revive item dates
  if (Array.isArray(state.items)) {
    for (const item of state.items as CartLineItem[]) {
      if (typeof item.createdAt === 'string') item.createdAt = new Date(item.createdAt);
      if (typeof item.updatedAt === 'string') item.updatedAt = new Date(item.updatedAt);
    }
  }
  return state as CartState;
}
