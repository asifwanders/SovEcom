/**
 * offline breached-password check.
 *
 * EU-privacy rule forbids network egress (no HIBP range API). This is a small
 * BUNDLED denylist of the most common / most-breached passwords, matched
 * case-insensitively. It is intentionally minimal — the real defence is the
 * min-12 length policy + Argon2id; this catches the long-tail of trivially weak
 * 12+ char passwords (`password1234`, `123456789012`, …). A larger bundled list
 * can be dropped in later without touching the call sites.
 *
 * No network. No PII leaves the process.
 */
const BREACHED: ReadonlySet<string> = new Set(
  [
    'password',
    'password1',
    'password12',
    'password123',
    'password1234',
    'passw0rd123',
    '123456789012',
    '1234567890123',
    'qwertyuiop12',
    'qwerty123456',
    'iloveyou1234',
    'adminadmin12',
    'letmein12345',
    'welcome12345',
    'changeme1234',
    'sovecom12345',
    'administrator',
    'aaaaaaaaaaaa',
    '111111111111',
    '000000000000',
  ].map((p) => p.toLowerCase()),
);

/** True when `password` is in the bundled breached/weak denylist. */
export function isBreachedPassword(password: string): boolean {
  return BREACHED.has(password.toLowerCase());
}
