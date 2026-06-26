/**
 * STORAGE_SIGNING_SECRET resolution + production guard.
 *
 * Both the signed-URL minter ({@link LocalAdapter}) and the verifier
 * ({@link StorageController}) need the HMAC signing secret. Centralised here so
 * the production fail-closed rule is enforced ONCE for every reader (mirroring
 * TokenService.getSigningKey for JWT_SECRET):
 *
 *   - In production a missing secret, a secret shorter than 256 bits, or the dev
 *     default is a HARD boot failure (a default/weak secret lets anyone forge a
 *     signed URL).
 *   - In dev/test the well-known default is allowed so local setup needs no env.
 */
export const STORAGE_SIGNING_SECRET_DEV_DEFAULT = 'dev-signing-secret';

/** Minimum secret length in production (256-bit, matching the JWT_SECRET rule). */
const MIN_SECRET_BYTES = 32;

/**
 * Resolve + validate `STORAGE_SIGNING_SECRET`. Throws at construction/boot in
 * production when the secret is unset, too short, or the dev default. Returns the
 * validated secret (or the dev default outside production).
 */
export function resolveStorageSigningSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env['STORAGE_SIGNING_SECRET'];
  const isProd = env['NODE_ENV'] === 'production';

  if (isProd) {
    if (!secret || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
      throw new Error('STORAGE_SIGNING_SECRET must be set and at least 256 bits in production');
    }
    if (secret === STORAGE_SIGNING_SECRET_DEV_DEFAULT) {
      throw new Error('STORAGE_SIGNING_SECRET must not be the dev default in production');
    }
    return secret;
  }

  return secret ?? STORAGE_SIGNING_SECRET_DEV_DEFAULT;
}
