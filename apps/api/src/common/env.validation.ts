/**
 *hardening — central environment validation.
 *
 * Wired into `ConfigModule.forRoot({ validate: validateEnv })` so the API
 * fail-closes at boot on a misconfigured PRODUCTION environment, instead of
 * each per-service guard discovering the problem lazily (and inconsistently).
 *
 * Design constraints:
 *   - PRODUCTION: presence + format of the core vars, and known-default /
 *     strength rejection for every secret. This is DEFENCE-IN-DEPTH — it
 *     coexists with the per-service guards (TokenService.getSigningKey,
 *     resolveStorageSigningSecret, resolveMeiliMasterKey, AeadService) which
 *     stay as the authoritative last line; the rules here intentionally match.
 *   - OUTSIDE production (dev/test): PERMISSIVE. Missing vars and weak secrets
 *     must NOT break local boot or the existing test suite. We validate nothing
 *     beyond shape and return the env untouched.
 */
import { z } from 'zod';

/** 256-bit minimum for symmetric secrets (matches the per-service guards). */
const MIN_SECRET_BYTES = 32;

/** Known-default / weak secret values rejected in production. */
const KNOWN_DEFAULT_SECRETS = new Set([
  'changeme',
  'secret',
  'dev',
  'devkey',
  'masterkey',
  'dev-signing-secret',
]);

/** A production secret: present, >= 256-bit, and not a known default. */
function prodSecret(name: string): z.ZodType<string> {
  return z
    .string({ message: `${name} must be set in production` })
    .min(1, `${name} must be set in production`)
    .refine((v) => Buffer.byteLength(v, 'utf8') >= MIN_SECRET_BYTES, {
      message: `${name} must be at least 256 bits in production`,
    })
    .refine((v) => !KNOWN_DEFAULT_SECRETS.has(v.toLowerCase()), {
      message: `${name} must not be a known default in production`,
    });
}

/**
 * `MASTER_KEY` is base64 of a 32-byte key (not a UTF-8 secret). Validate the
 * DECODED length and reject the all-zero placeholder, alongside known-default
 * literals. Mirrors AeadService.assertNotDefaultInProduction.
 */
const prodMasterKey: z.ZodType<string> = z
  .string({ message: 'MASTER_KEY must be set in production' })
  .min(1, 'MASTER_KEY must be set in production')
  .refine((v) => !KNOWN_DEFAULT_SECRETS.has(v.toLowerCase()), {
    message: 'MASTER_KEY must not be a known default in production',
  })
  .refine(
    (v) => {
      const decoded = Buffer.from(v, 'base64');
      return decoded.length === MIN_SECRET_BYTES && !decoded.every((b) => b === 0);
    },
    { message: 'MASTER_KEY must decode to a non-zero 32-byte key in production' },
  );

/** The fail-closed production schema. Unknown keys pass through untouched. */
const prodSchema = z
  .object({
    DATABASE_URL: z
      .string({ message: 'DATABASE_URL must be set in production' })
      .min(1, 'DATABASE_URL must be set in production'),
    REDIS_URL: z
      .string({ message: 'REDIS_URL must be set in production' })
      .min(1, 'REDIS_URL must be set in production'),
    JWT_SECRET: prodSecret('JWT_SECRET'),
    MASTER_KEY: prodMasterKey,
    MEILI_MASTER_KEY: prodSecret('MEILI_MASTER_KEY'),
    STORAGE_SIGNING_SECRET: prodSecret('STORAGE_SIGNING_SECRET'),
  })
  .passthrough();

/**
 * Validate the process environment at boot. Throws (aborting boot) only when
 * `NODE_ENV === 'production'` and a core var is missing / malformed / a known
 * default. Outside production the env is returned unchanged (permissive).
 *
 * Exported plain (not bound to `process.env`) so it is unit-testable with a
 * synthetic env object.
 */
export function validateEnv(env: Record<string, unknown>): Record<string, unknown> {
  if (env['NODE_ENV'] !== 'production') {
    return env;
  }

  const result = prodSchema.safeParse(env);
  if (!result.success) {
    const message = result.error.issues.map((i) => i.message).join('; ');
    throw new Error(`Invalid production environment: ${message}`);
  }
  return result.data;
}
