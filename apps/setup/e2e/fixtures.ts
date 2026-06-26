/**
 * setup-wizard E2E fixtures (scenario 1, fresh install).
 *
 * The happy-path inputs MIRROR `apps/setup/src/full-flow.spec.tsx` (the vitest that drives the whole
 * wizard against a mock API) so the browser E2E and the unit flow stay in lock-step. Two values are
 * resolved at RUNTIME from the live environment (they cannot be hardcoded — they are minted fresh on
 * each boot / emailed per run):
 *
 *   - SETUP_TOKEN_PLAINTEXT — the one-time setup token. SetupBootService mints it at boot on a
 * not-installed system and prints it in the stdout banner (its SOLE plaintext emission
 *     §6 — only its SHA-256 hash is stored, so it can't be read from the DB). The harness greps it
 *     out of the API log and exports it here. No production code change.
 *
 *   - the admin OTP — the admin-account step emails a 6-digit code (never logged/returned). The
 *     wizard's Email step points SMTP at MailHog (the dev mail sink the EmailStep itself references),
 *     and the spec reads the code back over MailHog's HTTP API at MAILHOG_API_URL.
 */

/** The plaintext setup token, read from the boot banner by the harness (see e2e/README.md). */
export const SETUP_TOKEN = process.env.SETUP_TOKEN_PLAINTEXT ?? '';

/** MailHog's HTTP API base (messages JSON) — where the admin-account OTP is read back. */
export const MAILHOG_API_URL = process.env.MAILHOG_API_URL ?? 'http://localhost:8025';

/** The local mail sink the wizard's SMTP step is pointed at (MailHog SMTP). */
export const SMTP_HOST = process.env.SETUP_E2E_SMTP_HOST ?? 'localhost';
export const SMTP_PORT = process.env.SETUP_E2E_SMTP_PORT ?? '1025';

/** The owner account the wizard creates — mirrors full-flow.spec.tsx. */
export const ADMIN_NAME = 'Ada Lovelace';
export const ADMIN_EMAIL = 'ada@example.com';
/** A long passphrase that clears the API's min-12 + breach check (mirrors full-flow.spec.tsx). */
export const ADMIN_PASSWORD = 'correct-horse-battery-staple-92';

/** The store sender + Tax inputs (mirror full-flow.spec.tsx: FR / EU VAT). */
export const FROM_ADDRESS = 'store@example.com';
export const BUSINESS_COUNTRY = 'FR';
export const VAT_NUMBER = 'FR12345678901';
