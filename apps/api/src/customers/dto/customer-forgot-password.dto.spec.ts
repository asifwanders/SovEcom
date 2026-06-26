/**
 * CustomerForgotPasswordDto schema (AUTH/CREDENTIAL-CRITICAL).
 *
 * Pins the boundary contract for the UNAUTH forgot-password body: a valid email is
 * required + normalized (trim + lower-case), max length is enforced, and `.strict()`
 * rejects unknown keys (no mass-assignment).
 */
import { CustomerForgotPasswordSchema } from './customer-forgot-password.dto';

describe('CustomerForgotPasswordSchema', () => {
  it('accepts a well-formed email', () => {
    const parsed = CustomerForgotPasswordSchema.parse({ email: 'user@example.com' });
    expect(parsed).toEqual({ email: 'user@example.com' });
  });

  it('trims + lower-cases the email', () => {
    const parsed = CustomerForgotPasswordSchema.parse({ email: '  User.Name@Example.COM  ' });
    expect(parsed.email).toBe('user.name@example.com');
  });

  it('rejects a malformed email', () => {
    expect(() => CustomerForgotPasswordSchema.parse({ email: 'not-an-email' })).toThrow();
    expect(() => CustomerForgotPasswordSchema.parse({ email: 'a@' })).toThrow();
    expect(() => CustomerForgotPasswordSchema.parse({ email: '' })).toThrow();
  });

  it('rejects an email longer than 254 chars', () => {
    const tooLong = `${'a'.repeat(250)}@x.test`;
    expect(() => CustomerForgotPasswordSchema.parse({ email: tooLong })).toThrow();
  });

  it('rejects a missing email', () => {
    expect(() => CustomerForgotPasswordSchema.parse({})).toThrow();
  });

  it('rejects unknown keys (.strict — no mass-assignment)', () => {
    expect(() =>
      CustomerForgotPasswordSchema.parse({ email: 'user@example.com', tenantId: 'x' }),
    ).toThrow();
    expect(() =>
      CustomerForgotPasswordSchema.parse({ email: 'user@example.com', token: 'x' }),
    ).toThrow();
  });
});
