/**
 * Shared recursive redaction utility.
 *
 * Used by the logging interceptor, the global exception filter and (later) the
 * Drizzle logger so that no secret value is ever written to a log line or echoed
 * in an error body. The function deep-clones its input and replaces the VALUE of
 * any key whose name (case-insensitively) is in {@link SECRET_KEYS} with the
 * sentinel `'[REDACTED]'`. Non-secret keys are preserved verbatim.
 *
 * Properties:
 * - Pure: never mutates the input; returns a fresh structure.
 * - Total: non-object scalars (string/number/boolean/null/undefined/bigint/symbol)
 *   are returned as-is. A bare secret-shaped string passed at the top level is NOT
 *   redacted — redaction is keyed on the *property name*, not the value.
 * - Cycle-safe: a WeakSet tracks visited objects; a re-encountered reference is
 *   replaced with `'[Circular]'` instead of recursing forever.
 * - Array-aware: arrays are mapped element-by-element.
 */

export const REDACTED = '[REDACTED]';

/**
 * Property names whose values must never appear in logs or error responses.
 * Matching is case-insensitive (see {@link redact}). Keep in sync with the auth
 * surface: credentials, all token kinds, TOTP material, the
 * stateful 2FA challenge id, QR/otpauth enrollment payloads and the raw
 * `Authorization` / `Cookie` / `Set-Cookie` headers — plus the app's own
 * credential-bearing config field names (`pass`, `url`, `uri`, `dsn`).
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set(
  [
    'password',
    'newPassword',
    'currentPassword',
    'token',
    'refreshToken',
    'accessToken',
    'totpCode',
    'totpSecret',
    'secret',
    'otpauthUrl',
    'qrDataUrl',
    'challengeId',
    'authorization',
    'cookie',
    'set-cookie',
    'jwt',
    // App-config credential field names the stems miss: the SMTP
    // password ships as `pass`, and DB/Redis connection strings (Postgres URL,
    // redis:// URI) embed credentials in `url` / `uri` / `dsn`. Exact keys
    // (not a broad `url` stem) so only these credential-bearing fields redact.
    'pass',
    'url',
    'uri',
    'dsn',
  ].map((k) => k.toLowerCase()),
);

/**
 * Secret STEMS matched as substrings of the normalised key (lowercased, with all
 * non-alphanumerics stripped). Substring matching catches the many real-world
 * variants exact-key matching misses — `apiKey`, `x-api-key`, `client_secret`,
 * `sessionToken`, `authToken`, `dbPassword`, `set-cookie` — at the cost of some
 * benign over-redaction (e.g. `tokenVersion`), which is the safe direction.
 */
const SECRET_STEMS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'jwt',
  'totp',
  'otpauth',
  'qrdata',
  'challengeid',
  'credential',
  'privatekey',
  'passphrase',
];

/** Maximum recursion depth before a branch is summarised — prevents RangeError. */
export const MAX_REDACT_DEPTH = 64;

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SECRET_KEYS.has(lower)) return true;
  const normalised = lower.replace(/[^a-z0-9]/g, '');
  return SECRET_STEMS.some((stem) => normalised.includes(stem));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactInner(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  // Scalars and functions are returned unchanged.
  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Depth cap: summarise rather than recurse into pathologically deep structures
  // (prevents a RangeError that would otherwise propagate out of the caller).
  if (depth >= MAX_REDACT_DEPTH) {
    return '[Truncated]';
  }

  // Cycle guard: a re-encountered reference becomes a marker, never recursion.
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactInner(item, seen, depth + 1));
  }

  // Objects whose values we can't meaningfully clone (Date, Buffer, Map, etc.)
  // are passed through as-is — they are not key/value bags we redact into.
  if (!isPlainRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    // Skip prototype-pollution keys defensively (never copy __proto__ etc.).
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    if (isSecretKey(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactInner(value[key], seen, depth + 1);
    }
  }
  return out;
}

/**
 * Deep-clone `value`, replacing the value of any secret-named key with
 * `'[REDACTED]'`. Total and non-throwing (depth-capped). See the module doc.
 */
export function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet<object>(), 0);
}
