/**
 *hardening — central env validation UNIT tests.
 *
 * `ConfigModule.forRoot` now runs `validateEnv` on boot. It must:
 *   - In PRODUCTION: reject missing core vars and known-default / weak secrets
 *     (mirroring the per-service guards — they coexist, this is defence-in-depth).
 *   - OUTSIDE production (dev/test): be permissive — missing vars and weak
 *     secrets must NOT break local boot or the existing test suite.
 */
import { validateEnv } from './env.validation';

const STRONG = 'x'.repeat(32);
const STRONG_B64 = Buffer.alloc(32, 0x5a).toString('base64');

/** A complete, strong production env (the happy path). */
function prodEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: STRONG,
    MASTER_KEY: STRONG_B64,
    MEILI_MASTER_KEY: STRONG,
    STORAGE_SIGNING_SECRET: STRONG,
  };
}

describe('validateEnv — central boot validation', () => {
  describe('outside production (dev/test) — permissive', () => {
    it('allows an empty env (missing everything)', () => {
      expect(() => validateEnv({})).not.toThrow();
    });

    it('allows a NODE_ENV=test env with no secrets', () => {
      expect(() => validateEnv({ NODE_ENV: 'test' })).not.toThrow();
    });

    it('allows known-default secrets in development', () => {
      expect(() =>
        validateEnv({
          NODE_ENV: 'development',
          JWT_SECRET: 'changeme',
          MEILI_MASTER_KEY: 'devkey',
        }),
      ).not.toThrow();
    });

    it('returns the env object unchanged outside production', () => {
      const env = { NODE_ENV: 'test', FOO: 'bar' };
      expect(validateEnv(env)).toBe(env);
    });
  });

  describe('production — fail-closed', () => {
    it('accepts a complete, strong production env', () => {
      expect(() => validateEnv(prodEnv())).not.toThrow();
    });

    it('rejects a missing DATABASE_URL', () => {
      const env = prodEnv();
      delete env.DATABASE_URL;
      expect(() => validateEnv(env)).toThrow(/DATABASE_URL/);
    });

    it('rejects a missing REDIS_URL', () => {
      const env = prodEnv();
      delete env.REDIS_URL;
      expect(() => validateEnv(env)).toThrow(/REDIS_URL/);
    });

    it('rejects a known-default JWT_SECRET', () => {
      const env = prodEnv();
      env.JWT_SECRET = 'changeme';
      expect(() => validateEnv(env)).toThrow(/JWT_SECRET/);
    });

    it('rejects a too-short JWT_SECRET', () => {
      const env = prodEnv();
      env.JWT_SECRET = 'short';
      expect(() => validateEnv(env)).toThrow(/JWT_SECRET/);
    });

    it('rejects the devkey MEILI_MASTER_KEY', () => {
      const env = prodEnv();
      env.MEILI_MASTER_KEY = 'devkey';
      expect(() => validateEnv(env)).toThrow(/MEILI_MASTER_KEY/);
    });

    it('rejects the dev-default STORAGE_SIGNING_SECRET', () => {
      const env = prodEnv();
      env.STORAGE_SIGNING_SECRET = 'dev-signing-secret';
      expect(() => validateEnv(env)).toThrow(/STORAGE_SIGNING_SECRET/);
    });

    it('rejects an all-zero MASTER_KEY', () => {
      const env = prodEnv();
      env.MASTER_KEY = Buffer.alloc(32, 0).toString('base64');
      expect(() => validateEnv(env)).toThrow(/MASTER_KEY/);
    });
  });
});
