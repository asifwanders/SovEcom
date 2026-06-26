/**
 * Unit tests — settings resolution + clamping.
 */
import { describe, it, expect } from 'vitest';
import { resolveSettings, DEFAULT_MAX_ITEMS, MAX_ITEMS_HARD_CAP } from '../src/settings';

describe('resolveSettings', () => {
  it('falls back to safe defaults for undefined / garbage', () => {
    expect(resolveSettings(undefined)).toEqual({
      enabled: true,
      maxItemsPerCustomer: DEFAULT_MAX_ITEMS,
      weeklyDigest: false,
    });
    expect(resolveSettings(42)).toMatchObject({
      enabled: true,
      maxItemsPerCustomer: DEFAULT_MAX_ITEMS,
    });
    expect(resolveSettings(null)).toMatchObject({ maxItemsPerCustomer: DEFAULT_MAX_ITEMS });
  });

  it('honors explicit valid values', () => {
    expect(
      resolveSettings({ enabled: false, maxItemsPerCustomer: 25, weeklyDigest: true }),
    ).toEqual({
      enabled: false,
      maxItemsPerCustomer: 25,
      weeklyDigest: true,
    });
  });

  it('clamps the cap to [1, HARD_CAP] and floors fractions', () => {
    expect(resolveSettings({ maxItemsPerCustomer: 0 }).maxItemsPerCustomer).toBe(1);
    expect(resolveSettings({ maxItemsPerCustomer: -5 }).maxItemsPerCustomer).toBe(1);
    expect(resolveSettings({ maxItemsPerCustomer: 10_000 }).maxItemsPerCustomer).toBe(
      MAX_ITEMS_HARD_CAP,
    );
    expect(resolveSettings({ maxItemsPerCustomer: 12.9 }).maxItemsPerCustomer).toBe(12);
  });

  it('ignores wrong-typed fields', () => {
    expect(
      resolveSettings({ enabled: 'yes', weeklyDigest: 1, maxItemsPerCustomer: 'lots' }),
    ).toEqual({
      enabled: true,
      maxItemsPerCustomer: DEFAULT_MAX_ITEMS,
      weeklyDigest: false,
    });
  });
});
