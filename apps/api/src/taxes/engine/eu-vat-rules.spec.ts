/**
 * EU VAT rules + money-helper unit tests.
 */
import {
  EU_MEMBER_STATES,
  EU_STANDARD_RATES,
  computeVat,
  isEuCountry,
  roundHalfUp,
} from './eu-vat-rules';

describe('EU member-state data', () => {
  it('has exactly 27 member states with rates', () => {
    expect(EU_STANDARD_RATES.size).toBe(27);
    expect(EU_MEMBER_STATES.size).toBe(27);
  });

  it('includes the core EU countries and excludes non-EU', () => {
    for (const c of ['FR', 'DE', 'IT', 'ES', 'BE', 'NL']) {
      expect(isEuCountry(c)).toBe(true);
    }
    for (const c of ['US', 'GB', 'CH', 'PK', null, undefined, '']) {
      expect(isEuCountry(c)).toBe(false);
    }
  });

  it('isEuCountry is case-insensitive', () => {
    expect(isEuCountry('fr')).toBe(true);
    expect(isEuCountry('De')).toBe(true);
  });

  it('rates are valid fractions in [0,1)', () => {
    for (const [, rate] of EU_STANDARD_RATES) {
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThan(1);
    }
  });
});

describe('roundHalfUp', () => {
  it('rounds .5 up', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(832.5)).toBe(833);
    expect(roundHalfUp(19.95)).toBe(20);
  });

  it('rounds below .5 down', () => {
    expect(roundHalfUp(0.49)).toBe(0);
    expect(roundHalfUp(832.4)).toBe(832);
  });

  it('handles integers and zero', () => {
    expect(roundHalfUp(0)).toBe(0);
    expect(roundHalfUp(100)).toBe(100);
  });
});

describe('computeVat', () => {
  it('exclusive: round_half_up(base × rate)', () => {
    expect(computeVat(10000, 0.2, false)).toBe(2000);
    expect(computeVat(105, 0.19, false)).toBe(20); // 19.95 → 20
  });

  it('inclusive: gross − round_half_up(gross / (1+rate))', () => {
    expect(computeVat(12000, 0.2, true)).toBe(2000); // net 10000
    expect(computeVat(999, 0.2, true)).toBe(166); // net round(832.5)=833 → 166
  });

  it('zero/negative base or rate → 0', () => {
    expect(computeVat(0, 0.2, false)).toBe(0);
    expect(computeVat(10000, 0, false)).toBe(0);
    expect(computeVat(-100, 0.2, false)).toBe(0);
  });

  it('never returns negative', () => {
    expect(computeVat(1, 0.2, true)).toBeGreaterThanOrEqual(0);
  });
});
