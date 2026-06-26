/**
 * ChangeEmailDto schema (AUTH/CREDENTIAL/PII-CRITICAL).
 *
 * Pins the boundary contract for the email-change INITIATE body: a valid email is
 * required + normalized to lower-case, `currentPassword` is bounded, max lengths are
 * enforced, and `.strict()` rejects unknown keys (no mass-assignment).
 */
import { ChangeEmailSchema } from './change-email.dto';

describe('ChangeEmailSchema', () => {
  const valid = {
    newEmail: 'new@example.com',
    currentPassword: 'correct horse battery staple',
  };

  it('accepts a well-formed body', () => {
    const parsed = ChangeEmailSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it('lower-cases the newEmail (toLowerCase)', () => {
    const parsed = ChangeEmailSchema.parse({ ...valid, newEmail: 'New.User@Example.COM' });
    expect(parsed.newEmail).toBe('new.user@example.com');
  });

  it('rejects a malformed email', () => {
    expect(() => ChangeEmailSchema.parse({ ...valid, newEmail: 'not-an-email' })).toThrow();
    expect(() => ChangeEmailSchema.parse({ ...valid, newEmail: 'a@' })).toThrow();
    expect(() => ChangeEmailSchema.parse({ ...valid, newEmail: '' })).toThrow();
  });

  it('rejects a newEmail longer than 320 chars', () => {
    const longLocal = `${'a'.repeat(312)}@x.test`; // 312 + 7 = 319 ok, push over with more
    expect(() => ChangeEmailSchema.parse({ ...valid, newEmail: longLocal })).not.toThrow();
    const tooLong = `${'a'.repeat(320)}@x.test`;
    expect(() => ChangeEmailSchema.parse({ ...valid, newEmail: tooLong })).toThrow();
  });

  it('rejects a missing or empty currentPassword', () => {
    expect(() => ChangeEmailSchema.parse({ newEmail: valid.newEmail })).toThrow();
    expect(() => ChangeEmailSchema.parse({ ...valid, currentPassword: '' })).toThrow();
  });

  it('rejects a currentPassword longer than 1024 chars', () => {
    expect(() =>
      ChangeEmailSchema.parse({ ...valid, currentPassword: 'a'.repeat(1025) }),
    ).toThrow();
  });

  it('rejects a missing newEmail', () => {
    expect(() => ChangeEmailSchema.parse({ currentPassword: valid.currentPassword })).toThrow();
  });

  it('rejects unknown keys (.strict — no mass-assignment)', () => {
    expect(() => ChangeEmailSchema.parse({ ...valid, tenantId: 'x' })).toThrow();
    expect(() => ChangeEmailSchema.parse({ ...valid, pendingEmail: 'x@y.test' })).toThrow();
    expect(() => ChangeEmailSchema.parse({ ...valid, tokenVersion: 99 })).toThrow();
  });
});
