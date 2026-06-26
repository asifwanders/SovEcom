/**
 * CustomerResetPasswordDto schema (AUTH/CREDENTIAL-CRITICAL).
 *
 * Pins the boundary contract for the UNAUTH reset body: `token` must be the exact
 * 43-char base64url shape of a 32-byte CSPRNG token, `newPassword` enforces the SAME
 * min-12 / max-1024 policy as signup, and `.strict()` rejects unknown keys (no
 * mass-assignment). The breached-password denylist is enforced in the service.
 */
import { CustomerResetPasswordSchema } from './customer-reset-password.dto';

describe('CustomerResetPasswordSchema', () => {
  // 43-char base64url (32 bytes → base64url, no padding) — matches randomBytes(32).
  const token = 'A'.repeat(43);
  const valid = { token, newPassword: 'a brand new strong passphrase' };

  it('accepts a well-formed body', () => {
    const parsed = CustomerResetPasswordSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it('accepts the base64url alphabet (A-Z a-z 0-9 - _)', () => {
    const mixed = 'abcDEF012-_'.padEnd(43, 'x'); // 43 chars, valid alphabet
    expect(() => CustomerResetPasswordSchema.parse({ ...valid, token: mixed })).not.toThrow();
  });

  it('rejects a token that is not exactly 43 chars', () => {
    expect(() => CustomerResetPasswordSchema.parse({ ...valid, token: 'A'.repeat(42) })).toThrow();
    expect(() => CustomerResetPasswordSchema.parse({ ...valid, token: 'A'.repeat(44) })).toThrow();
  });

  it('rejects a token with non-base64url characters', () => {
    expect(() =>
      CustomerResetPasswordSchema.parse({ ...valid, token: `${'A'.repeat(42)}+` }),
    ).toThrow(); // '+' is base64, not base64url
    expect(() =>
      CustomerResetPasswordSchema.parse({ ...valid, token: `${'A'.repeat(42)}=` }),
    ).toThrow(); // padding not allowed
  });

  it('rejects a newPassword shorter than 12 chars (same policy as signup)', () => {
    expect(() => CustomerResetPasswordSchema.parse({ ...valid, newPassword: 'short' })).toThrow();
    expect(() =>
      CustomerResetPasswordSchema.parse({ ...valid, newPassword: 'a'.repeat(11) }),
    ).toThrow();
  });

  it('accepts a newPassword of exactly 12 chars', () => {
    expect(() =>
      CustomerResetPasswordSchema.parse({ ...valid, newPassword: 'a'.repeat(12) }),
    ).not.toThrow();
  });

  it('rejects a newPassword longer than 1024 chars', () => {
    expect(() =>
      CustomerResetPasswordSchema.parse({ ...valid, newPassword: 'a'.repeat(1025) }),
    ).toThrow();
  });

  it('rejects a missing token or newPassword', () => {
    expect(() => CustomerResetPasswordSchema.parse({ newPassword: valid.newPassword })).toThrow();
    expect(() => CustomerResetPasswordSchema.parse({ token })).toThrow();
  });

  it('rejects unknown keys (.strict — no mass-assignment)', () => {
    expect(() => CustomerResetPasswordSchema.parse({ ...valid, tokenVersion: 99 })).toThrow();
    expect(() => CustomerResetPasswordSchema.parse({ ...valid, passwordHash: 'x' })).toThrow();
  });

  it('does NOT enforce the breached denylist (that runs in the service)', () => {
    expect(() =>
      CustomerResetPasswordSchema.parse({ ...valid, newPassword: 'password1234' }),
    ).not.toThrow();
  });
});
