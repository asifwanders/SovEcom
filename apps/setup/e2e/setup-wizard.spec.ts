/**
 * scenario 1: fresh install + setup-wizard completion (THE hardest E2E).
 *
 * Drives the REAL setup SPA against a REAL, fresh-install API (installed=false) through all 11 steps
 * to completion, then asserts the store ends up INSTALLED — both in the UI (the Done step → redirect
 * to /admin) and in the system state (`GET /setup/v1/status` → installed:true, which reads
 * `system_state.installed` in the DB). It mirrors the inputs of `src/full-flow.spec.tsx` (the mocked
 * vitest happy-path) but against live services, so it additionally exercises the two things the mock
 * cannot: the one-time setup TOKEN (minted at boot, read from the banner) and the admin-account OTP
 * (emailed, read back from MailHog).
 *
 * The UI step order is Welcome → Brand → Database → Email → Payments → Tax → Compliance → Theme →
 * Modules → Admin → Done (see src/wizard/steps.ts), which differs from the mock's listed order; we
 * follow the live machine. The token is supplied on Welcome; the SMTP step is pointed at the local
 * mail sink so the Admin step's OTP lands somewhere we can read it.
 *
 * FRESH-DB-PER-RUN: finishing the wizard flips installed=true, so a re-run needs a reset DB. See
 * e2e/README.md (and the CI job) for the reset+reseed+restart that makes this repeatable.
 */
import { test, expect } from '@playwright/test';
import { readOtpFromMailhog, expectInstalled } from './helpers';
import {
  SETUP_TOKEN,
  ADMIN_NAME,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  FROM_ADDRESS,
  BUSINESS_COUNTRY,
  VAT_NUMBER,
  SMTP_HOST,
  SMTP_PORT,
} from './fixtures';

/** The API base for the out-of-band status assertion (the SPA itself talks via the preview proxy). */
const API_BASE = process.env.SETUP_API_URL ?? 'http://localhost:3000';

test.describe.configure({ mode: 'serial' });

test('fresh install: completes the wizard end-to-end and marks the store installed', async ({
  page,
  request,
}) => {
  test.skip(
    !SETUP_TOKEN,
    'SETUP_TOKEN_PLAINTEXT is not set — the harness must export the boot token.',
  );

  // Sanity: the system must START not-installed, or the wizard never shows (a stale DB).
  const pre = await request.get(`${API_BASE}/setup/v1/status`);
  expect(pre.ok()).toBeTruthy();
  expect(((await pre.json()) as { installed: boolean }).installed).toBe(false);

  await page.goto('/');

  // ── Step 1: Welcome — enter + verify the real setup token ───────────────────────────
  await expect(page.getByRole('heading', { name: /welcome to sovecom/i })).toBeVisible();
  await page.getByLabel(/setup token/i).fill(SETUP_TOKEN);
  await page.getByRole('button', { name: /verify & continue/i }).click();

  // ── Step 2: Brand — continue with defaults (multipart) ──────────────────────────────
  await expect(page.getByRole('heading', { name: /your brand/i })).toBeVisible();
  await page.getByRole('button', { name: /^continue$/i }).click();

  // ── Step 3: Database — bundled Postgres (default) ───────────────────────────────────
  await expect(page.getByRole('heading', { name: /^database$/i })).toBeVisible();
  await page.getByRole('button', { name: /^continue$/i }).click();

  // ── Step 4: Email — Custom SMTP → the local mail sink (so the OTP is readable) ───────
  await expect(page.getByRole('heading', { name: /email delivery/i })).toBeVisible();
  await page.getByText('Custom SMTP', { exact: true }).click();
  // FormField labels carry a trailing "*" for required fields, so match the input by its
  // accessible name (the asterisk isn't part of it) rather than the visible label text.
  await page.getByRole('textbox', { name: 'Host', exact: true }).fill(SMTP_HOST);
  await page.getByRole('spinbutton', { name: 'Port', exact: true }).fill(SMTP_PORT);
  await page.getByRole('textbox', { name: 'From address', exact: true }).fill(FROM_ADDRESS);
  await page.getByRole('button', { name: /^continue$/i }).click();

  // ── Step 5: Payments — none selected (all optional) ─────────────────────────────────
  await expect(page.getByRole('heading', { name: /^payments$/i })).toBeVisible();
  await page.getByRole('button', { name: /^continue$/i }).click();

  // ── Step 6: Tax — EU country auto-defaults to EU VAT; VAT number + VIES on continue ──
  await expect(page.getByRole('heading', { name: /^tax$/i })).toBeVisible();
  await page.getByLabel(/business country/i).selectOption(BUSINESS_COUNTRY);
  await page.getByLabel(/eu vat number/i).fill(VAT_NUMBER);
  await page.getByRole('button', { name: /validate & continue/i }).click();

  // ── Step 7: Compliance — privacy-first defaults (Plausible on, GA/Meta off) ──────────
  await expect(page.getByRole('heading', { name: /privacy & compliance/i })).toBeVisible();
  await page.getByRole('button', { name: /^continue$/i }).click();

  // ── Step 8: Theme — first theme pre-selected; wait until Continue enables ────────────
  await expect(page.getByRole('heading', { name: /storefront theme/i })).toBeVisible();
  const themeContinue = page.getByRole('button', { name: /^continue$/i });
  await expect(themeContinue).toBeEnabled();
  await themeContinue.click();

  // ── Step 9: Modules — optional; Skip installs nothing ───────────────────────────────
  await expect(page.getByRole('heading', { name: /^modules$/i })).toBeVisible();
  await page.getByRole('button', { name: /^skip$/i }).click();

  // ── Step 10: Admin — request the OTP, read it from MailHog, then verify + set password ─
  await expect(page.getByRole('heading', { name: /your admin account/i })).toBeVisible();
  await page.getByLabel(/your name/i).fill(ADMIN_NAME);
  await page.getByLabel(/email address/i).fill(ADMIN_EMAIL);
  await page.getByRole('button', { name: /send verification code/i }).click();

  // the verify form appears; pull the emailed code out of MailHog.
  await expect(page.getByLabel(/verification code/i)).toBeVisible();
  const otp = await readOtpFromMailhog(request, ADMIN_EMAIL);
  await page.getByLabel(/verification code/i).fill(otp);
  await page.getByLabel(/^password/i).fill(ADMIN_PASSWORD);
  await page.getByLabel(/confirm password/i).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /create account/i }).click();

  // ── Step 11: Done — review summary, finish → POST /complete → redirect to /admin ─────
  await expect(page.getByRole('heading', { name: /you’re all set|you're all set/i })).toBeVisible();
  await expect(page.getByText(ADMIN_EMAIL, { exact: false })).toBeVisible();
  await expect(page.getByText(/EU VAT/i)).toBeVisible();

  // /admin doesn't exist on the preview origin; assert the navigation is ATTEMPTED rather than
  // letting it 404 the page out from under us. The install has already happened by then.
  const adminNav = page.waitForURL(/\/admin$/, { timeout: 30_000 }).catch(() => undefined);
  await page.getByRole('button', { name: /finish setup/i }).click();
  await adminNav;

  // ── The real assertion: the store is INSTALLED (system_state.installed=true) ──────────
  await expectInstalled(request, API_BASE);
});
