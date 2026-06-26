import { describe, it, expect } from 'vitest';
import { formatPrice, currencyFractionDigits, minorToMajor, majorToMinor } from './api';
// Z2: dead helpers removed — verify they are NOT exported (would be a compile error otherwise).
import * as apiModule from './api';

describe('formatPrice', () => {
  it('formats a 2-decimal currency (EUR)', () => {
    expect(formatPrice(1234, 'EUR')).toBe('€12.34');
  });
  it('formats a 2-decimal currency (USD)', () => {
    expect(formatPrice(999, 'USD')).toBe('$9.99');
  });
  it('formats a ZERO-decimal currency (JPY) without dividing by 100', () => {
    // 1234 yen = ¥1,234 (no minor unit). The old /100 showed ¥12.
    const result = formatPrice(1234, 'JPY');
    expect(result).toContain('1,234');
    expect(result).not.toContain('12.34');
  });
  it('formats a THREE-decimal currency (KWD) using 3 minor digits', () => {
    // 1234 fils = 1.234 KWD. The old /100 showed 12.34.
    const result = formatPrice(1234, 'KWD');
    expect(result).toContain('1.234');
    expect(result).not.toContain('12.34');
  });
  it('falls back gracefully for a malformed currency code (no throw)', () => {
    const result = formatPrice(1000, 'INVALID');
    expect(result).toContain('10.00');
  });
  it('accepts an explicit locale (S3: locale-aware formatting)', () => {
    // EUR with fr locale — value must still be correct; exact symbol placement is locale-specific.
    const result = formatPrice(1234, 'EUR', 'fr');
    expect(result).toContain('12');
    expect(result).toContain('34');
  });
  it('falls back to undefined locale when none provided (backward compat)', () => {
    // No locale argument → same behaviour as before (Intl default).
    expect(formatPrice(1234, 'EUR')).toBe('€12.34');
  });
});

describe('currencyFractionDigits', () => {
  it('returns 2 for EUR/USD', () => {
    expect(currencyFractionDigits('EUR')).toBe(2);
    expect(currencyFractionDigits('USD')).toBe(2);
  });
  it('returns 0 for JPY', () => {
    expect(currencyFractionDigits('JPY')).toBe(0);
  });
  it('returns 3 for KWD', () => {
    expect(currencyFractionDigits('KWD')).toBe(3);
  });
  it('falls back to 2 for a malformed code', () => {
    expect(currencyFractionDigits('INVALID')).toBe(2);
  });
});

describe('minorToMajor', () => {
  it('converts EUR cents to euros', () => {
    expect(minorToMajor(1999, 'EUR')).toBe(19.99);
  });
  it('converts JPY (no minor unit) 1:1', () => {
    expect(minorToMajor(1234, 'JPY')).toBe(1234);
  });
  it('converts KWD fils with 3 digits', () => {
    expect(minorToMajor(1234, 'KWD')).toBe(1.234);
  });
});

describe('Z2: dead exports removed', () => {
  it('storeFetch is no longer exported from api (superseded by store-client)', () => {
    expect((apiModule as Record<string, unknown>)['storeFetch']).toBeUndefined();
  });
  it('storeFetchList is no longer exported from api (superseded by store-client)', () => {
    expect((apiModule as Record<string, unknown>)['storeFetchList']).toBeUndefined();
  });
});

describe('majorToMinor', () => {
  it('parses a major-unit EUR string to integer minor units', () => {
    expect(majorToMinor('19.99', 'EUR')).toBe(1999);
  });
  it('rounds to an integer (never a float in the query)', () => {
    const v = majorToMinor('19.999', 'EUR');
    expect(v).toBe(2000);
    expect(Number.isInteger(v)).toBe(true);
  });
  it('accepts a comma decimal separator (FR locale)', () => {
    expect(majorToMinor('19,99', 'EUR')).toBe(1999);
  });
  it('parses a zero-decimal currency (JPY) with no scaling', () => {
    expect(majorToMinor('1234', 'JPY')).toBe(1234);
  });
  it('returns null for blank input (caller omits the param)', () => {
    expect(majorToMinor('', 'EUR')).toBeNull();
    expect(majorToMinor('   ', 'EUR')).toBeNull();
  });
  it('returns null for garbage input', () => {
    expect(majorToMinor('abc', 'EUR')).toBeNull();
  });
  it('returns null for a negative value', () => {
    expect(majorToMinor('-5', 'EUR')).toBeNull();
  });
});
