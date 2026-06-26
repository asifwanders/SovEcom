/**
 * Playwright E2E config. This is the browser-level acceptance
 * harness for the storefront — the gate for the criteria jsdom/Vitest cannot run:
 * real a11y (axe), real JSON-LD parsing from the rendered DOM, and the mobile+desktop smoke flow.
 *
 * Projects: Desktop Chrome + Pixel 5 (mobile) — every spec runs at BOTH viewports (the §3.7
 * "mobile+desktop" requirement). Chromium-only by design: CI installs only the chromium browser
 * (one `playwright install --with-deps chromium` step), which keeps the job fast; the storefront is
 * standard responsive HTML with no engine-specific behaviour, so cross-engine coverage is out of
 * scope here.
 *
 * baseURL comes from `E2E_BASE_URL` (the started storefront — :3001 by default; see package.json
 * `start`). `webServer` lets the suite run LOCALLY end-to-end (`pnpm build` then `pnpm start`) with
 * no manual setup; in CI the job starts the storefront itself and sets `E2E_SKIP_WEBSERVER=1`, so
 * Playwright reuses the already-running server instead of starting a second one.
 *
 * CROSS-THEME: the same specs must pass on BOTH bundled themes (default + boutique). The
 * theme is selected by the SERVER-RUNTIME `STOREFRONT_THEME` env (read in the RSC `resolveActiveThemeName`
 * — NO rebuild needed to switch), so we parametrize via the `THEME` env: each run boots ONE storefront
 * pinned to a theme and tags every project with that theme. `pnpm test:e2e:default` / `test:e2e:boutique`
 * run the two; CI runs both as a matrix (the runner starts the storefront with the right
 * `STOREFRONT_THEME` and sets `E2E_SKIP_WEBSERVER=1`). The smoke / cart-checkout / a11y / json-ld specs
 * are theme-agnostic (they target always-present chrome) and pass on both; `theme.spec.ts` asserts the
 * theme-distinguishing markers. `THEME` defaults to `default` so a bare `test:e2e` keeps prior behaviour.
 *
 * The API (the storefront's data source) is NOT started by Playwright — it is a separate process the
 * CI job boots + seeds first (and a local runner must start themselves). The specs are written to be
 * resilient to an EMPTY catalog (the seed creates legal `pages` + tax/shipping but NO products or
 * categories — see e2e/README): catalog-dependent assertions are guarded, the always-present
 * content (home chrome, legal pages, robots/sitemap, site-wide JSON-LD) is asserted unconditionally.
 */
import { defineConfig, devices } from '@playwright/test';

/** The running storefront origin. Defaults to the local `pnpm start` port (:3001). */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3001';

/** In CI the job already started the storefront — skip Playwright's own `webServer`. */
const skipWebServer = process.env.E2E_SKIP_WEBSERVER === '1' || process.env.CI === 'true';

/**
 * The bundled theme under test. One run = one theme: a `default`-unset run keeps the
 * unchanged default-theme behaviour, `boutique` exercises the editorial chrome/templates. The locally
 * started `webServer` passes this through as `STOREFRONT_THEME`; in CI the runner sets that env itself.
 * Specs read `process.env.THEME` to branch the theme-distinguishing assertions in `theme.spec.ts`.
 */
const THEME = process.env.THEME === 'boutique' ? 'boutique' : 'default';

export default defineConfig({
  testDir: './e2e',
  // CI must never silently pass because someone left a `test.only` in a spec.
  forbidOnly: !!process.env.CI,
  // E2E is occasionally flaky under cold ISR / first-paint; retry in CI, none locally.
  retries: process.env.CI ? 2 : 0,
  // CI runs SERIALLY (one worker). The storefront SSR-fetches the catalog/pages from a single
  // dev-mode API instance at request time; under a parallel page-load burst that API drops some
  // requests and the routes' resilient fallback renders a contentless page, flaking the a11y gate.
  // One worker keeps each SSR fetch sequential — deterministic, at a small wall-clock cost.
  workers: process.env.CI ? 1 : undefined,
  // Per-test ceiling — generous for the first cold ISR render of a route.
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    // Visual-regression tolerance. A SMALL pixel-ratio threshold absorbs sub-pixel
    // font-rendering / anti-aliasing jitter across runners without masking real layout regressions;
    // `animations: 'disabled'` freezes CSS animations/transitions so captures are deterministic. The
    // baselines are generated on the first CI run per (theme × viewport) — see e2e/README.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
  },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL,
    // Artifacts only on failure — keeps the happy path fast and the report small.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  // Projects are tagged with the active THEME so the HTML report + traces name which theme produced a
  // result (`desktop-chromium-boutique`, etc.). Each run pins a single theme (see THEME above).
  projects: [
    {
      name: `desktop-chromium-${THEME}`,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: `mobile-chromium-${THEME}`,
      use: { ...devices['Pixel 5'] },
    },
  ],
  // Local-only convenience: build + start the storefront so `pnpm test:e2e` works with zero setup.
  // Skipped in CI (the job starts the server with its own STOREFRONT_THEME). Requires the API to be
  // reachable separately. `STOREFRONT_THEME` is a SERVER-runtime env: `pnpm start` reads it at request
  // time, so no rebuild is needed to switch themes (the build is theme-agnostic).
  ...(skipWebServer
    ? {}
    : {
        webServer: {
          command: 'pnpm build && pnpm start',
          url: baseURL,
          reuseExistingServer: true,
          timeout: 180_000,
          env: { STOREFRONT_THEME: THEME },
        },
      }),
});
