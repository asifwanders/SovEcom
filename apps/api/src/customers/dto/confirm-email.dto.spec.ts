/**
 * ConfirmEmailDto schema (AUTH/CREDENTIAL/PII-CRITICAL).
 *
 * Pins the boundary contract for the PUBLIC email-change CONFIRM body: a non-empty
 * bounded `token` is required and `.strict()` rejects unknown keys.
 */
import { ConfirmEmailSchema } from './confirm-email.dto';

describe('ConfirmEmailSchema', () => {
  const valid = { token: 'abcDEF123-_base64url-token' };

  it('accepts a well-formed body', () => {
    expect(ConfirmEmailSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a token of exactly 512 chars', () => {
    expect(() => ConfirmEmailSchema.parse({ token: 'a'.repeat(512) })).not.toThrow();
  });

  it('rejects an empty token', () => {
    expect(() => ConfirmEmailSchema.parse({ token: '' })).toThrow();
  });

  it('rejects a missing token', () => {
    expect(() => ConfirmEmailSchema.parse({})).toThrow();
  });

  it('rejects a token longer than 512 chars', () => {
    expect(() => ConfirmEmailSchema.parse({ token: 'a'.repeat(513) })).toThrow();
  });

  it('rejects unknown keys (.strict — no mass-assignment)', () => {
    expect(() => ConfirmEmailSchema.parse({ ...valid, customerId: 'x' })).toThrow();
    expect(() => ConfirmEmailSchema.parse({ ...valid, newEmail: 'x@y.test' })).toThrow();
  });
});
