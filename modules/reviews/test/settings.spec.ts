/**
 * reviews — settings resolver unit tests. Every field must clamp to a safe range so a
 * missing/garbage value can never break body validation or silently auto-publish.
 */
import { describe, it, expect } from 'vitest';
import { resolveSettings, DEFAULT_SETTINGS, MAX_TEXT_HARD_CAP } from '../src/settings';

describe('resolveSettings', () => {
  it('returns defaults for undefined / garbage', () => {
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings('nope')).toEqual(DEFAULT_SETTINGS);
  });

  it('honors valid values', () => {
    const s = resolveSettings({
      enabled: false,
      minTextLen: 5,
      maxTextLen: 500,
      autoApprove: true,
    });
    expect(s).toEqual({ enabled: false, minTextLen: 5, maxTextLen: 500, autoApprove: true });
  });

  it('clamps maxTextLen to [1, HARD_CAP] and floors floats', () => {
    expect(resolveSettings({ maxTextLen: 0 }).maxTextLen).toBe(1);
    expect(resolveSettings({ maxTextLen: 999999 }).maxTextLen).toBe(MAX_TEXT_HARD_CAP);
    expect(resolveSettings({ maxTextLen: 12.9 }).maxTextLen).toBe(12);
  });

  it('clamps minTextLen to >= 0 and never above the effective maxTextLen', () => {
    expect(resolveSettings({ minTextLen: -5 }).minTextLen).toBe(0);
    // min above max collapses to max so the bounds never invert.
    const s = resolveSettings({ minTextLen: 100, maxTextLen: 20 });
    expect(s.minTextLen).toBe(20);
    expect(s.maxTextLen).toBe(20);
  });

  it('ignores unknown keys', () => {
    const s = resolveSettings({ enabled: true, bogus: 'x' } as Record<string, unknown>);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('defaults autoApprove to false (reviews are moderated by default)', () => {
    expect(resolveSettings({}).autoApprove).toBe(false);
  });
});
