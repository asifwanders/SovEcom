/**
 * Accessibility gate. Runs @axe-core/playwright against
 * the key storefront surfaces and fails on ANY serious/critical WCAG 2.1 A/AA violation. This is the
 * real a11y check jsdom cannot perform (no layout, no computed contrast, no focus model) — it runs at
 * BOTH the desktop and mobile viewports via the two Playwright projects.
 *
 * Routes covered: home, products index (PLP), category index, search (empty form), and every seeded
 * legal page. The catalog is empty in CI (the seed publishes legal `pages` + tax/shipping but NO
 * products/categories — see e2e/README), so a per-product PDP and a category PLP have no fixture to
 * load; those surfaces' a11y is exercised by the in-house component Vitest+axe specs and
 * by the empty-but-valid PLP/search states here. The legal pages are real, seeded content.
 */
import { test, expect } from '@playwright/test';
import {
  LOCALES,
  SEEDED_LEGAL_SLUGS,
  localePath,
  seriousAxeViolations,
  formatViolations,
} from './helpers';

/** The always-present, locale-LESS route paths (catalog-independent). */
const STATIC_PATHS = ['', 'products', 'category', 'search'];

for (const locale of LOCALES) {
  test.describe(`a11y (${locale})`, () => {
    for (const path of STATIC_PATHS) {
      test(`no serious/critical axe violations on /${locale}/${path}`, async ({ page }) => {
        await page.goto(localePath(locale, path));
        // The header/footer chrome is always present; wait for the main landmark before scanning.
        await expect(page.locator('main#main-content')).toBeVisible();
        const violations = await seriousAxeViolations(page);
        expect(violations, formatViolations(violations)).toEqual([]);
      });
    }

    for (const slug of SEEDED_LEGAL_SLUGS) {
      test(`no serious/critical axe violations on legal page /${locale}/${slug}`, async ({
        page,
      }) => {
        const res = await page.goto(localePath(locale, slug));
        // The legal pages are seeded + published, so they must render (not 404). If a future seed
        // change drops a slug this assertion catches it rather than silently passing on a 404 shell.
        expect(res?.status(), `legal page /${locale}/${slug} should be served`).toBeLessThan(400);
        // The route renders the page TITLE as the SOLE <article> h1; the authored Markdown body's
        // own headings are downshifted (Markdown shiftHeadings), so there is exactly one h1 per page
        // (a11y/SEO). The full-page axe scan below still covers the whole article.
        const h1 = page.locator('article h1');
        await expect(h1).toHaveCount(1);
        await expect(h1).toBeVisible();
        const violations = await seriousAxeViolations(page);
        expect(violations, formatViolations(violations)).toEqual([]);
      });
    }
  });
}
