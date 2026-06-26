/**
 * DB_POOL_MAX parse safety tests.
 *
 * `Number(process.env.DB_POOL_MAX ?? 10)` yields NaN on a non-numeric value,
 * which silently corrupts the postgres.js pool sizing. `resolveDbPoolMax`
 * parses safely: a missing / non-numeric / non-positive / non-finite value
 * falls back to the default 10; a valid positive integer is used as-is.
 */
import { resolveDbPoolMax } from './database.service';

describe('resolveDbPoolMax — safe pool-size parse', () => {
  it('defaults to 10 when unset', () => {
    expect(resolveDbPoolMax(undefined)).toBe(10);
  });

  it('uses a valid positive integer', () => {
    expect(resolveDbPoolMax('25')).toBe(25);
  });

  it('falls back to 10 on a non-numeric value (NaN guard)', () => {
    expect(resolveDbPoolMax('abc')).toBe(10);
  });

  it('falls back to 10 on zero / negative values', () => {
    expect(resolveDbPoolMax('0')).toBe(10);
    expect(resolveDbPoolMax('-5')).toBe(10);
  });

  it('falls back to 10 on a non-finite value (Infinity)', () => {
    expect(resolveDbPoolMax('Infinity')).toBe(10);
  });

  it('floors a fractional value to an integer', () => {
    expect(resolveDbPoolMax('12.9')).toBe(12);
  });
});
