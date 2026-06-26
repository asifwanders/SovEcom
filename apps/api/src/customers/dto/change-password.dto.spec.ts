/**
 * ChangePasswordDto schema (AUTH/CREDENTIAL-CRITICAL).
 *
 * Pins the boundary contract: both passwords are required, `newPassword` enforces
 * the SAME min-12 / max-1024 policy as signup, `currentPassword` is bounded, and
 * `.strict()` rejects unknown keys (no mass-assignment of internal columns). The
 * breached-password denylist is enforced in the service, NOT the schema (mirrors
 * signup) — so a 12+ char common password parses here and is rejected downstream.
 */
import { ChangePasswordSchema } from './change-password.dto';

describe('ChangePasswordSchema', () => {
  const valid = {
    currentPassword: 'correct horse battery staple',
    newPassword: 'a brand new strong passphrase',
  };

  it('accepts a well-formed body', () => {
    const parsed = ChangePasswordSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it('rejects a newPassword shorter than 12 chars (same policy as signup)', () => {
    expect(() => ChangePasswordSchema.parse({ ...valid, newPassword: 'short' })).toThrow();
    expect(() => ChangePasswordSchema.parse({ ...valid, newPassword: 'a'.repeat(11) })).toThrow();
  });

  it('accepts a newPassword of exactly 12 chars', () => {
    expect(() =>
      ChangePasswordSchema.parse({ ...valid, newPassword: 'a'.repeat(12) }),
    ).not.toThrow();
  });

  it('rejects a newPassword longer than 1024 chars', () => {
    expect(() => ChangePasswordSchema.parse({ ...valid, newPassword: 'a'.repeat(1025) })).toThrow();
  });

  it('rejects a missing or empty currentPassword', () => {
    expect(() => ChangePasswordSchema.parse({ newPassword: valid.newPassword })).toThrow();
    expect(() => ChangePasswordSchema.parse({ ...valid, currentPassword: '' })).toThrow();
  });

  it('rejects a currentPassword longer than 1024 chars', () => {
    expect(() =>
      ChangePasswordSchema.parse({ ...valid, currentPassword: 'a'.repeat(1025) }),
    ).toThrow();
  });

  it('rejects unknown keys (.strict — no mass-assignment)', () => {
    expect(() => ChangePasswordSchema.parse({ ...valid, tokenVersion: 99 })).toThrow();
    expect(() => ChangePasswordSchema.parse({ ...valid, passwordHash: 'x' })).toThrow();
  });

  it('does NOT enforce the breached denylist (that runs in the service)', () => {
    // A 12+ char common password parses at the boundary; the service rejects it.
    expect(() =>
      ChangePasswordSchema.parse({ ...valid, newPassword: 'password1234' }),
    ).not.toThrow();
  });
});
