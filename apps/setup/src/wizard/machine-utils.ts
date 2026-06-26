import { TOTAL_STEPS } from './steps';

export { loadProgress, saveProgress, clearProgress } from './storage';
export type { PersistedProgress } from './storage';

/** Keep an index inside the valid step range — defends against a stale/corrupt persisted value. */
export function clampIndex(index: number): number {
  if (!Number.isFinite(index)) return 0;
  if (index < 0) return 0;
  if (index > TOTAL_STEPS - 1) return TOTAL_STEPS - 1;
  return Math.floor(index);
}
