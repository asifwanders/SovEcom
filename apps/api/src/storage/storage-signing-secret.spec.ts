/**
 * STORAGE_SIGNING_SECRET production guard UNIT tests.
 *
 * Mirrors the JWT_SECRET fail-closed rule: in production a missing / short / dev-default
 * signing secret is a hard boot failure (a weak secret lets anyone forge a signed URL).
 * In dev the well-known default is allowed so local setup needs no env.
 */
import {
  resolveStorageSigningSecret,
  STORAGE_SIGNING_SECRET_DEV_DEFAULT,
} from './storage-signing-secret';

const STRONG = 'x'.repeat(32); // exactly 256-bit, not the dev default

describe('resolveStorageSigningSecret — production fail-closed', () => {
  it('throws in production when the secret is UNSET', () => {
    expect(() => resolveStorageSigningSecret({ NODE_ENV: 'production' })).toThrow(
      /STORAGE_SIGNING_SECRET/,
    );
  });

  it('throws in production when the secret is the DEV DEFAULT', () => {
    expect(() =>
      resolveStorageSigningSecret({
        NODE_ENV: 'production',
        STORAGE_SIGNING_SECRET: STORAGE_SIGNING_SECRET_DEV_DEFAULT,
      }),
    ).toThrow(/STORAGE_SIGNING_SECRET/);
  });

  it('throws in production when the secret is shorter than 256 bits', () => {
    expect(() =>
      resolveStorageSigningSecret({ NODE_ENV: 'production', STORAGE_SIGNING_SECRET: 'short' }),
    ).toThrow(/STORAGE_SIGNING_SECRET/);
  });

  it('accepts a strong secret in production', () => {
    expect(
      resolveStorageSigningSecret({ NODE_ENV: 'production', STORAGE_SIGNING_SECRET: STRONG }),
    ).toBe(STRONG);
  });

  it('falls back to the dev default outside production (no env required)', () => {
    expect(resolveStorageSigningSecret({ NODE_ENV: 'development' })).toBe(
      STORAGE_SIGNING_SECRET_DEV_DEFAULT,
    );
  });

  it('uses a provided secret in dev as-is', () => {
    expect(
      resolveStorageSigningSecret({ NODE_ENV: 'test', STORAGE_SIGNING_SECRET: 'whatever' }),
    ).toBe('whatever');
  });
});
