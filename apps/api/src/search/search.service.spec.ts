/**
 * MEILI_MASTER_KEY production guard UNIT tests.
 *
 * Mirrors the JWT_SECRET / STORAGE_SIGNING_SECRET fail-closed rule: in
 * production an unset or known-default ('devkey') Meilisearch master key is a
 * hard boot failure (a default key lets anyone read/write every tenant index).
 * In dev/test the well-known default is allowed so local setup needs no env.
 */
import { resolveMeiliMasterKey, MEILI_MASTER_KEY_DEV_DEFAULT } from './search.service';

const STRONG = 'x'.repeat(32);

describe('resolveMeiliMasterKey — production fail-closed', () => {
  it('throws in production when the key is UNSET', () => {
    expect(() => resolveMeiliMasterKey({ NODE_ENV: 'production' })).toThrow(/MEILI_MASTER_KEY/);
  });

  it('throws in production when the key is the DEV DEFAULT (devkey)', () => {
    expect(() =>
      resolveMeiliMasterKey({
        NODE_ENV: 'production',
        MEILI_MASTER_KEY: MEILI_MASTER_KEY_DEV_DEFAULT,
      }),
    ).toThrow(/MEILI_MASTER_KEY/);
  });

  it('accepts a strong key in production', () => {
    expect(resolveMeiliMasterKey({ NODE_ENV: 'production', MEILI_MASTER_KEY: STRONG })).toBe(
      STRONG,
    );
  });

  it('throws in production for a known default in any casing (MasterKey)', () => {
    expect(() =>
      resolveMeiliMasterKey({ NODE_ENV: 'production', MEILI_MASTER_KEY: 'MasterKey' }),
    ).toThrow(/MEILI_MASTER_KEY/);
  });

  it('throws in production for a too-short (non-default) key', () => {
    expect(() =>
      resolveMeiliMasterKey({ NODE_ENV: 'production', MEILI_MASTER_KEY: 'short-but-not-default' }),
    ).toThrow(/32 characters/);
  });

  it('falls back to the dev default outside production (no env required)', () => {
    expect(resolveMeiliMasterKey({ NODE_ENV: 'development' })).toBe(MEILI_MASTER_KEY_DEV_DEFAULT);
  });

  it('uses a provided key in dev as-is', () => {
    expect(resolveMeiliMasterKey({ NODE_ENV: 'test', MEILI_MASTER_KEY: 'whatever' })).toBe(
      'whatever',
    );
  });
});
