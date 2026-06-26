/**
 * Visual-regression E2E. Pixel-diffs a handful of REPRESENTATIVE pages against committed
 * baselines, per THEME (the run's `STOREFRONT_THEME`) and per VIEWPORT (the two Playwright projects) —
 * so a styling regression in either bundled theme, at either breakpoint, is caught.
 *
 * Baselines DO NOT exist on the first run; they are generated on the first CI run per
 * (theme × viewport × page) with `--update-snapshots` (see e2e/README "Visual regression"). This file
 * only declares WHAT to capture; the threshold + animation freeze live in playwright.config.ts
 * (`expect.toHaveScreenshot`).
 *
 * Catalog dependence: home + the PLP index + the cart PAGE shell are always present (empty-but-valid on
 * the CI seed), so they capture unconditionally. The PDP needs the deterministic fixture product
 * (`SEED_E2E_FIXTURE=1`), so it `test.skip`s on an empty catalog — exactly like the JSON-LD / cart specs.
 *
 * `maxDiffPixelRatio` (config) absorbs sub-pixel AA jitter; `fullPage` captures below the fold so a
 * footer/section regression is visible. `dismissCookieBanner` removes the first-visit overlay so it
 * doesn't pollute every baseline.
 */
import { test, expect } from '@playwright/test';
import { localePath, dismissCookieBanner } from './helpers';
import { hasFixture, seedConsentCookie, E2E_PRODUCT_SLUG } from './fixtures';

/** The theme this run was booted with — used only to NAME the screenshot files (theme-scoped baselines). */
const THEME = process.env.THEME === 'boutique' ? 'boutique' : 'default';

test.describe(`visual regression (${THEME})`, () => {
  test('home page', async ({ page }) => {
    await page.goto(localePath('en'));
    await dismissCookieBanner(page);
    await expect(page).toHaveScreenshot(`${THEME}-home.png`, { fullPage: true });
  });

  test('products index (PLP)', async ({ page }) => {
    await page.goto(localePath('en', 'products'));
    await dismissCookieBanner(page);
    await expect(page).toHaveScreenshot(`${THEME}-products.png`, { fullPage: true });
  });

  test('category index', async ({ page }) => {
    await page.goto(localePath('en', 'category'));
    await dismissCookieBanner(page);
    await expect(page).toHaveScreenshot(`${THEME}-category.png`, { fullPage: true });
  });

  test('cart page (empty-state shell)', async ({ page }) => {
    // The cart PAGE shell is server-rendered chrome + the empty-state body (no cart context needed for
    // a fresh visit), so it captures deterministically without seeding a cart.
    await seedConsentCookie(page);
    await page.goto(localePath('en', 'cart'));
    await expect(page).toHaveScreenshot(`${THEME}-cart.png`, { fullPage: true });
  });

  test('product detail (PDP)', async ({ page }) => {
    test.skip(!(await hasFixture(page)), 'empty catalog — no fixture product to capture');
    await seedConsentCookie(page);
    await page.goto(localePath('en', `product/${E2E_PRODUCT_SLUG}`));
    await dismissCookieBanner(page);
    await expect(page).toHaveScreenshot(`${THEME}-product.png`, { fullPage: true });
  });
});
