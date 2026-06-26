/**
 * reviews — validation unit tests (rating + body). Control chars are injected via JSON \u escapes
 * or String.fromCharCode, so NO raw control byte ever appears in source.
 */
import { describe, it, expect } from 'vitest';
import { validateRating, validateBody, hasForbiddenControlChar } from '../src/api/validation';

describe('validateRating', () => {
  it.each([1, 2, 3, 4, 5])('accepts integer %i', (n) => {
    const r = validateRating(n);
    expect(r.ok).toBe(true);
  });

  it.each([0, 6, -1, 4.5, 2.0001, NaN, Infinity, '5', null, undefined, {}])('rejects %p', (v) => {
    expect(validateRating(v).ok).toBe(false);
  });
});

describe('validateBody', () => {
  it('trims and accepts a body within bounds', () => {
    const r = validateBody('   hello world   ', 1, 100);
    expect(r).toEqual({ ok: true, body: 'hello world' });
  });

  it('rejects too short / too long with specific codes', () => {
    expect(validateBody('hi', 5, 100)).toEqual({ ok: false, error: 'body_too_short' });
    expect(validateBody('x'.repeat(20), 1, 10)).toEqual({ ok: false, error: 'body_too_long' });
  });

  it('measures length in code points (an emoji counts as one)', () => {
    // "😀😀" is 2 code points but 4 UTF-16 units — must pass a maxLen of 2.
    const r = validateBody('\u{1F600}\u{1F600}', 1, 2);
    expect(r.ok).toBe(true);
  });

  it('rejects forbidden control chars (NUL, BEL, ESC, DEL)', () => {
    for (const code of [0x00, 0x07, 0x1b, 0x7f]) {
      const body = `abc${String.fromCharCode(code)}def`;
      expect(validateBody(body, 1, 100)).toEqual({ ok: false, error: 'body_has_control_chars' });
    }
  });

  it('allows the whitespace controls TAB / LF / CR in a body', () => {
    const body = `line one${String.fromCharCode(0x0a)}line two${String.fromCharCode(0x09)}tab${String.fromCharCode(0x0d)}`;
    const r = validateBody(body, 1, 100);
    expect(r.ok).toBe(true);
  });

  it('rejects a non-string', () => {
    expect(validateBody(123, 1, 100)).toEqual({ ok: false, error: 'invalid_body' });
  });
});

describe('hasForbiddenControlChar', () => {
  it('flags NUL but not LF', () => {
    expect(hasForbiddenControlChar(String.fromCharCode(0x00))).toBe(true);
    expect(hasForbiddenControlChar(String.fromCharCode(0x0a))).toBe(false);
  });
});
