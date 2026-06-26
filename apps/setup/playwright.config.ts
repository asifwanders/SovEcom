/**
 * setup-SPA E2E config (scenario 1: fresh install + wizard completion).
 * The setup app had NO browser tests; this stands up the harness. The setup wizard is a pure SPA
 * that calls the API from the browser, so the run needs:
 *   - the setup SPA built with `VITE_API_BASE_URL=""` (relative `/setup/v1/*` + `/health`), served
 *     by `vite preview` (default :4174) whose `preview.proxy` forwards those SAME-ORIGIN to the API
 *     → no CORS change (CORS never allows the setup origin). See vite.config.ts.
 *   - a FRESH-INSTALL API: a not-installed DB (installed=false) + baseline seed WITHOUT
 *     SEED_E2E_FIXTURE, started so SetupBootService mints + LOGS the one-time setup token. The spec
 *     reads that token from `SETUP_TOKEN_PLAINTEXT` (the harness greps it out of the API log).
 *   - a mail sink (MailHog) the wizard's SMTP step points at, so the admin-account OTP can be read
 *     back over MailHog's HTTP API (`MAILHOG_API_URL`). The OTP is never logged/returned by the API.
 *
 * Completing the wizard flips installed=true, so the spec is FRESH-DB-PER-RUN: re-running needs a
 * reset DB (drop+recreate, baseline seed, restart API). CI does exactly that; see e2e/README.md.
 *
 * Locally the `webServer` block builds + previews the SPA for zero-setup `pnpm test:e2e` (the API +
 * MailHog must be reachable separately). In CI the job starts everything and sets E2E_SKIP_WEBSERVER=1.
 */
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_SETUP_BASE_URL ?? 'http://localhost:4174';
const skipWebServer = process.env.E2E_SKIP_WEBSERVER === '1' || process.env.CI === 'true';

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: 0, // completing the wizard is single-use (flips installed); a retry would hit an installed DB
  workers: 1, // one wizard run mutates the shared install state — strictly serial
  timeout: 120_000, // the full 11-step real-API flow (incl. OTP email round-trip) is legitimately slow
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } }],
  ...(skipWebServer
    ? {}
    : {
        webServer: {
          // Build with an EMPTY API base (relative calls), then preview on :4174 — the preview
          // proxy (vite.config.ts) forwards /setup + /health to the API same-origin.
          command: 'pnpm build && pnpm preview --port 4174 --strictPort',
          url: baseURL,
          reuseExistingServer: true,
          timeout: 180_000,
          env: { VITE_API_BASE_URL: '' },
        },
      }),
});
