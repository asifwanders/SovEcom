/**
 * Docs capture of the setup wizard. Mirrors setup-wizard.spec.ts
 * (drives all 11 steps against a fresh-install API with the real token + MailHog OTP) but screenshots
 * the Welcome, Privacy & Compliance, and Admin-account steps into the operator-guide assets.
 * Guarded by CAPTURE_SETUP_FULL. Needs a fresh-install DB + MailHog + SETUP_TOKEN_PLAINTEXT (see
 * e2e/README.md). Run (NO E2E_SKIP_WEBSERVER — let it build+preview the SPA on :4174):
 *   CAPTURE_SETUP_FULL=1 SETUP_TOKEN_PLAINTEXT=<token> MAILHOG_API_URL=http://localhost:8025 \
 *     pnpm --filter @sovecom/setup exec playwright test docs-setup-full --project=desktop-chromium
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readOtpFromMailhog } from './helpers';
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

const OUT = resolve(process.cwd(), '../../docs/src/assets/operator-guides/getting-started');
const shot = (name: string) => {
  mkdirSync(OUT, { recursive: true });
  return resolve(OUT, `${name}.png`);
};

test('capture setup wizard screens', async ({ page, request }) => {
  test.skip(process.env.CAPTURE_SETUP_FULL !== '1', 'set CAPTURE_SETUP_FULL=1');
  test.skip(!SETUP_TOKEN, 'SETUP_TOKEN_PLAINTEXT not set');
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/');

  // Step 1: Welcome — screenshot the token step, then continue
  await expect(page.getByRole('heading', { name: /welcome to sovecom/i })).toBeVisible();
  await page.screenshot({ path: shot('setup-welcome') });
  await page.getByLabel(/setup token/i).fill(SETUP_TOKEN);
  await page.getByRole('button', { name: /verify & continue/i }).click();

  await expect(page.getByRole('heading', { name: /your brand/i })).toBeVisible();
  await page.getByRole('button', { name: /^continue$/i }).click();

  await expect(page.getByRole('heading', { name: /^database$/i })).toBeVisible();
  await page.getByRole('button', { name: /^continue$/i }).click();

  await expect(page.getByRole('heading', { name: /email delivery/i })).toBeVisible();
  await page.getByText('Custom SMTP', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Host', exact: true }).fill(SMTP_HOST);
  await page.getByRole('spinbutton', { name: 'Port', exact: true }).fill(SMTP_PORT);
  await page.getByRole('textbox', { name: 'From address', exact: true }).fill(FROM_ADDRESS);
  await page.getByRole('button', { name: /^continue$/i }).click();

  await expect(page.getByRole('heading', { name: /^payments$/i })).toBeVisible();
  await page.getByRole('button', { name: /^continue$/i }).click();

  await expect(page.getByRole('heading', { name: /^tax$/i })).toBeVisible();
  await page.getByLabel(/business country/i).selectOption(BUSINESS_COUNTRY);
  await page.getByLabel(/eu vat number/i).fill(VAT_NUMBER);
  await page.getByRole('button', { name: /validate & continue/i }).click();

  // Step 7: Compliance — screenshot the privacy/RGPD step
  await expect(page.getByRole('heading', { name: /privacy & compliance/i })).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot('setup-compliance') });
  await page.getByRole('button', { name: /^continue$/i }).click();

  await expect(page.getByRole('heading', { name: /storefront theme/i })).toBeVisible();
  const themeContinue = page.getByRole('button', { name: /^continue$/i });
  // In dev the theme gallery is minimal ("start on the default") and Continue can render disabled;
  // force the click to proceed to the Admin step (the only step we still need to screenshot).
  await themeContinue.click({ force: true }).catch(() => {});
  await page.waitForTimeout(800);
  if (
    await page
      .getByRole('heading', { name: /storefront theme/i })
      .isVisible()
      .catch(() => false)
  ) {
    // still on Theme — try selecting any theme card first, then continue
    await page
      .locator('button, [role="button"], [class*="card"]')
      .first()
      .click({ force: true })
      .catch(() => {});
    await themeContinue.click({ force: true }).catch(() => {});
  }

  await expect(page.getByRole('heading', { name: /^modules$/i })).toBeVisible();
  await page.getByRole('button', { name: /^skip$/i }).click();

  // Step 10: Admin account — request OTP, screenshot the verify+password phase
  await expect(page.getByRole('heading', { name: /your admin account/i })).toBeVisible();
  await page.getByLabel(/your name/i).fill(ADMIN_NAME);
  await page.getByLabel(/email address/i).fill(ADMIN_EMAIL);
  await page.getByRole('button', { name: /send verification code/i }).click();
  await expect(page.getByLabel(/verification code/i)).toBeVisible();
  const otp = await readOtpFromMailhog(request, ADMIN_EMAIL);
  await page.getByLabel(/verification code/i).fill(otp);
  await page.getByLabel(/^password/i).fill(ADMIN_PASSWORD);
  await page.getByLabel(/confirm password/i).fill(ADMIN_PASSWORD);
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot('setup-admin-account') });
  // Stop here — we only need the screenshots, not to complete the install (keeps re-runs cheaper).
  console.log('  ✓ captured setup-welcome, setup-compliance, setup-admin-account');
});
