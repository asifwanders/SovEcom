/**
 * recently-viewed — settings resolver unit tests. Pure clamping/normalization, no SDK.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveSettings,
  DEFAULT_SETTINGS,
  DEFAULT_MAX_ITEMS,
  MAX_ITEMS_HARD_CAP,
  MAX_EXCLUDE_CATEGORIES,
} from '../src/settings';

describe('recently-viewed settings — resolveSettings', () => {
  it('undefined / non-object bags fall back to safe defaults', () => {
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings('nope')).toEqual(DEFAULT_SETTINGS);
  });

  it('enabled defaults true and honours an explicit boolean', () => {
    expect(resolveSettings({}).enabled).toBe(true);
    expect(resolveSettings({ enabled: false }).enabled).toBe(false);
    // A non-boolean enabled falls back to the default (true), never coerced.
    expect(resolveSettings({ enabled: 'false' }).enabled).toBe(true);
  });

  it('maxItems is floored and clamped to [1, MAX_ITEMS_HARD_CAP]', () => {
    expect(resolveSettings({ maxItems: 12 }).maxItems).toBe(12);
    expect(resolveSettings({ maxItems: 12.9 }).maxItems).toBe(12);
    expect(resolveSettings({ maxItems: 0 }).maxItems).toBe(1);
    expect(resolveSettings({ maxItems: -5 }).maxItems).toBe(1);
    expect(resolveSettings({ maxItems: 9999 }).maxItems).toBe(MAX_ITEMS_HARD_CAP);
    // Non-finite / non-number → default.
    expect(resolveSettings({ maxItems: Number.NaN }).maxItems).toBe(DEFAULT_MAX_ITEMS);
    expect(resolveSettings({ maxItems: 'eight' }).maxItems).toBe(DEFAULT_MAX_ITEMS);
  });

  it('excludeCategories: a non-array → empty; valid strings kept, deduped, trimmed', () => {
    expect(resolveSettings({ excludeCategories: 'cat-1' }).excludeCategories).toEqual([]);
    expect(
      resolveSettings({ excludeCategories: ['cat-1', '  cat-2  ', 'cat-1'] }).excludeCategories,
    ).toEqual(['cat-1', 'cat-2']);
  });

  it('excludeCategories drops empty / non-string / over-long entries', () => {
    const bag = {
      excludeCategories: ['ok', '', '   ', 123, null, 'x'.repeat(65), 'fine'],
    };
    expect(resolveSettings(bag).excludeCategories).toEqual(['ok', 'fine']);
  });

  it('excludeCategories is bounded to MAX_EXCLUDE_CATEGORIES', () => {
    const many = Array.from({ length: MAX_EXCLUDE_CATEGORIES + 50 }, (_, i) => `cat-${i}`);
    expect(resolveSettings({ excludeCategories: many }).excludeCategories).toHaveLength(
      MAX_EXCLUDE_CATEGORIES,
    );
  });
});
