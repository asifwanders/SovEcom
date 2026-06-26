/**
 * admin-SPA E2E config. The admin app had NO browser tests; this stands up
 * the harness. The admin is a pure SPA that calls the API from the browser, so the run needs:
 *   - the admin built with `VITE_API_BASE_URL` pointing at the API (default http://localhost:3000),
 *     served by `vite preview` (default :4173);
 *   - the API running and seeded with SEED_E2E_FIXTURE=1 (gives admin@default.local a real password
 *     + installed=true) AND started with `ADMIN_ORIGIN` = this preview origin so CORS lets the SPA
 *     talk to it cross-origin (credentials).
 * Locally the `webServer` block builds + previews the admin for zero-setup `pnpm test:e2e` (the API
 * must be reachable separately). In CI the job starts everything and sets E2E_SKIP_WEBSERVER=1.
 */
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_ADMIN_BASE_URL ?? 'http://localhost:4173';
const apiBase = process.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
const skipWebServer = process.env.E2E_SKIP_WEBSERVER === '1' || process.env.CI === 'true';

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // serial: the CRUD spec mutates shared store state
  timeout: 60_000,
  expect: { timeout: 10_000 },
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
          // Build with the API base baked in, then preview the static SPA on :4173.
          command: 'pnpm build && pnpm preview --port 4173 --strictPort',
          url: baseURL,
          reuseExistingServer: true,
          timeout: 180_000,
          env: { VITE_API_BASE_URL: apiBase },
        },
      }),
});
