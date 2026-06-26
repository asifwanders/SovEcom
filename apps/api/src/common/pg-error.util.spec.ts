/**
 * pg-error util — SQLSTATE detection across raw + drizzle-wrapped errors.
 */
import {
  isUniqueViolation,
  isForeignKeyViolation,
  PG_UNIQUE_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
} from './pg-error.util';

describe('isUniqueViolation', () => {
  it('detects a raw postgres-js 23505', () => {
    expect(isUniqueViolation({ code: PG_UNIQUE_VIOLATION })).toBe(true);
  });
  it('detects a drizzle-wrapped 23505 (off .cause)', () => {
    expect(
      isUniqueViolation({ message: 'Failed query', cause: { code: PG_UNIQUE_VIOLATION } }),
    ).toBe(true);
  });
  it('is false for a non-unique error / non-object', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});

describe('isForeignKeyViolation', () => {
  it('detects a raw postgres-js 23503', () => {
    expect(isForeignKeyViolation({ code: PG_FOREIGN_KEY_VIOLATION })).toBe(true);
  });
  it('detects a drizzle-wrapped 23503 (off .cause)', () => {
    expect(
      isForeignKeyViolation({ message: 'Failed query', cause: { code: PG_FOREIGN_KEY_VIOLATION } }),
    ).toBe(true);
  });
  it('is false for a unique violation / non-object', () => {
    expect(isForeignKeyViolation({ code: PG_UNIQUE_VIOLATION })).toBe(false);
    expect(isForeignKeyViolation(undefined)).toBe(false);
    expect(isForeignKeyViolation('nope')).toBe(false);
  });
});
