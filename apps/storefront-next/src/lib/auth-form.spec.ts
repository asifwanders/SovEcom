import { describe, it, expect } from 'vitest';
import { SovEcomApiError } from '@sovecom/client-js';
import { isValidEmail, safeReturnTo, classifyRegisterError } from './auth-form';

describe('isValidEmail', () => {
  it('accepts a normal address', () => {
    expect(isValidEmail('a@b.com')).toBe(true);
    expect(isValidEmail('  user.name@sub.example.co  ')).toBe(true);
  });
  it('rejects empties, missing @, missing dot, and spaces', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a b@c.com')).toBe(false);
  });
});

describe('safeReturnTo (open-redirect guard)', () => {
  it('passes a root-relative internal path', () => {
    expect(safeReturnTo('/account')).toBe('/account');
    expect(safeReturnTo('/checkout?step=2')).toBe('/checkout?step=2');
  });
  it('rejects external, protocol-relative, scheme and empty/undefined', () => {
    expect(safeReturnTo(undefined)).toBeNull();
    expect(safeReturnTo('')).toBeNull();
    expect(safeReturnTo('https://evil.com')).toBeNull();
    expect(safeReturnTo('//evil.com')).toBeNull();
    expect(safeReturnTo('/\\evil.com')).toBeNull();
    expect(safeReturnTo('javascript:alert(1)')).toBeNull();
    expect(safeReturnTo('account')).toBeNull(); // not root-relative
  });
});

describe('classifyRegisterError (signup-then-login disambiguation)', () => {
  it('409 → duplicate email', () => {
    expect(classifyRegisterError(new SovEcomApiError(409, 'Conflict', undefined))).toBe(
      'duplicate',
    );
  });
  it('400 → weak password', () => {
    expect(classifyRegisterError(new SovEcomApiError(400, 'Bad Request', undefined))).toBe(
      'weak-password',
    );
  });
  it('401 (auto-login leg failed, signup succeeded) → account-created-sign-in', () => {
    expect(classifyRegisterError(new SovEcomApiError(401, 'Unauthorized', undefined))).toBe(
      'account-created-sign-in',
    );
  });
  it('anything else → unexpected', () => {
    expect(classifyRegisterError(new SovEcomApiError(500, 'Server Error', undefined))).toBe(
      'unexpected',
    );
    expect(classifyRegisterError(new Error('boom'))).toBe('unexpected');
  });
});
