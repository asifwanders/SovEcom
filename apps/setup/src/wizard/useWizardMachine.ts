import { useCallback, useMemo, useRef, useState } from 'react';
import { STEPS, TOTAL_STEPS, type StepDef, type StepId } from './steps';
import { clampIndex, clearProgress, loadProgress, saveProgress } from './machine-utils';

export interface WizardMachine {
  steps: readonly StepDef[];
  total: number;
  currentIndex: number;
  current: StepDef;
  /** Per-step data, keyed by step id. Steps read/write their own slice. */
  data: Record<string, unknown>;
  isFirst: boolean;
  isLast: boolean;
  canGoBack: boolean;
  /** Merge a partial slice for a step into persisted data (does not navigate). */
  setStepData: (id: StepId, value: unknown) => void;
  /** Advance one step, optionally committing this step's data first. */
  next: (data?: { id: StepId; value: unknown }) => void;
  /** Go back one step (no-op on the first step). */
  back: () => void;
  /** Skip forward (optional steps); identical mechanics to next, semantic intent differs. */
  skip: () => void;
  /** Jump to an arbitrary (clamped) index. */
  goTo: (index: number) => void;
  /** Wipe persisted progress + reset to the first step (used on completion). */
  reset: () => void;
}

/**
 * The wizard state machine. An ordered step list + a current index +
 * per-step data, all persisted to localStorage on every mutation so a refresh resumes
 * exactly where the operator left off. The token is handled separately (sessionStorage).
 */
export function useWizardMachine(): WizardMachine {
  // Read persisted progress ONCE, lazily, on mount — this is what makes a refresh resume.
  const initial = useRef(loadProgress()).current;
  const [currentIndex, setCurrentIndex] = useState<number>(clampIndex(initial?.currentIndex ?? 0));
  const [data, setData] = useState<Record<string, unknown>>(initial?.data ?? {});

  const persist = useCallback((index: number, nextData: Record<string, unknown>) => {
    saveProgress({ currentIndex: index, data: nextData });
  }, []);

  const setStepData = useCallback(
    (id: StepId, value: unknown) => {
      setData((prev) => {
        const merged = { ...prev, [id]: value };
        persist(currentIndex, merged);
        return merged;
      });
    },
    [currentIndex, persist],
  );

  const goTo = useCallback(
    (index: number) => {
      const clamped = clampIndex(index);
      setCurrentIndex(clamped);
      setData((current) => {
        persist(clamped, current);
        return current;
      });
    },
    [persist],
  );

  const next = useCallback(
    (commit?: { id: StepId; value: unknown }) => {
      const targetIndex = clampIndex(currentIndex + 1);
      setData((prev) => {
        const merged = commit ? { ...prev, [commit.id]: commit.value } : prev;
        persist(targetIndex, merged);
        return merged;
      });
      setCurrentIndex(targetIndex);
    },
    [currentIndex, persist],
  );

  const back = useCallback(() => {
    goTo(currentIndex - 1);
  }, [currentIndex, goTo]);

  const skip = useCallback(() => {
    next();
  }, [next]);

  const reset = useCallback(() => {
    clearProgress();
    setData({});
    setCurrentIndex(0);
  }, []);

  const current = STEPS[currentIndex] ?? STEPS[0]!;

  return useMemo<WizardMachine>(
    () => ({
      steps: STEPS,
      total: TOTAL_STEPS,
      currentIndex,
      current,
      data,
      isFirst: currentIndex === 0,
      isLast: currentIndex === TOTAL_STEPS - 1,
      canGoBack: currentIndex > 0 && current.id !== 'done',
      setStepData,
      next,
      back,
      skip,
      goTo,
      reset,
    }),
    [currentIndex, current, data, setStepData, next, back, skip, goTo, reset],
  );
}
