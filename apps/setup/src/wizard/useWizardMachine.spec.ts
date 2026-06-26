import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useWizardMachine } from './useWizardMachine';
import { PROGRESS_KEY } from './storage';
import { TOTAL_STEPS } from './steps';

describe('useWizardMachine', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts at step 0 with no persisted progress', () => {
    const { result } = renderHook(() => useWizardMachine());
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.current.id).toBe('welcome');
    expect(result.current.isFirst).toBe(true);
    expect(result.current.canGoBack).toBe(false);
  });

  it('next() advances and persists currentIndex + committed data', () => {
    const { result } = renderHook(() => useWizardMachine());
    act(() => result.current.next({ id: 'welcome', value: { verified: true } }));

    expect(result.current.currentIndex).toBe(1);
    const saved = JSON.parse(localStorage.getItem(PROGRESS_KEY)!);
    expect(saved.currentIndex).toBe(1);
    expect(saved.data.welcome).toEqual({ verified: true });
  });

  it('back() returns to the previous step', () => {
    const { result } = renderHook(() => useWizardMachine());
    act(() => result.current.next());
    act(() => result.current.back());
    expect(result.current.currentIndex).toBe(0);
  });

  it('skip() advances like next()', () => {
    const { result } = renderHook(() => useWizardMachine());
    act(() => result.current.skip());
    expect(result.current.currentIndex).toBe(1);
  });

  it('clamps a stale/out-of-range persisted index', () => {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 999, data: {} }));
    const { result } = renderHook(() => useWizardMachine());
    expect(result.current.currentIndex).toBe(TOTAL_STEPS - 1);
    expect(result.current.isLast).toBe(true);
  });

  it('hydrates currentIndex + data from localStorage on mount (refresh-safe)', () => {
    localStorage.setItem(
      PROGRESS_KEY,
      JSON.stringify({ currentIndex: 3, data: { brand: { color: '#fff' } } }),
    );
    const { result } = renderHook(() => useWizardMachine());
    expect(result.current.currentIndex).toBe(3);
    expect(result.current.data.brand).toEqual({ color: '#fff' });
  });

  it('reset() wipes persisted progress and returns to step 0', () => {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ currentIndex: 5, data: { x: 1 } }));
    const { result } = renderHook(() => useWizardMachine());
    act(() => result.current.reset());
    expect(result.current.currentIndex).toBe(0);
    expect(localStorage.getItem(PROGRESS_KEY)).toBeNull();
  });

  it('does not let back() go below the first step', () => {
    const { result } = renderHook(() => useWizardMachine());
    act(() => result.current.back());
    expect(result.current.currentIndex).toBe(0);
  });
});
