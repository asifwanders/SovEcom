import { describe, it, expect } from 'vitest';
import { formatMoney } from './money';

describe('formatMoney', () => {
  it('formats EUR cents', () => {
    expect(formatMoney(1234, 'EUR')).toBe('€12.34');
  });
  it('formats USD cents', () => {
    expect(formatMoney(999, 'USD')).toBe('$9.99');
  });
  it('formats zero', () => {
    expect(formatMoney(0, 'EUR')).toBe('€0.00');
  });
  it('formats a ZERO-decimal currency (JPY) without dividing by 100', () => {
    // 1234 minor units of JPY = ¥1,234 (yen has no minor unit). The old /100 showed ¥12.
    const result = formatMoney(1234, 'JPY');
    expect(result).toContain('1,234');
    expect(result).not.toContain('12.34');
  });
  it('formats a THREE-decimal currency (KWD) using 3 minor digits', () => {
    // 1234 fils = 1.234 KWD (Kuwaiti dinar has 3 minor digits). The old /100 showed 12.34.
    const result = formatMoney(1234, 'KWD');
    expect(result).toContain('1.234');
    expect(result).not.toContain('12.34');
  });
  it('falls back gracefully for an invalid currency code', () => {
    // Should not throw — returns the fallback string
    const result = formatMoney(1000, 'INVALID');
    expect(result).toContain('10.00');
  });
});
