/**
 * Cross-theme markers E2E. The other specs (smoke / cart-checkout / a11y / json-ld) are
 * THEME-AGNOSTIC — they assert always-present chrome and pass on both bundled themes. THIS spec is the
 * opposite: it asserts the markers that DISTINGUISH the active theme, so the cross-theme matrix proves
 * the boutique chrome/templates actually take effect (not just that the default keeps working).
 *
 * The active theme is selected by the server-runtime `STOREFRONT_THEME` env the run was booted with
 * (see playwright.config.ts); `process.env.THEME` mirrors it so we branch the expected markers.
 *
 * Markers (all on ALWAYS-PRESENT chrome — no catalog dependency, so they hold on the empty CI seed):
 *   - CART AFFORDANCE — default `drawer`: the header cart trigger is a <button aria-haspopup="dialog">;
 *     boutique `page-link`: it is an <a> link to `/cart` (no dialog semantics). This is the single most
 *     robust differentiator (chrome-variants `cart.affordance`).
 *   - HEADING FONT — boutique overrides the `--font-heading` CSS custom property to a SERIF stack; the
 *     default theme leaves it equal to `--font-sans` (no serif). The theme vars are applied inline on
 *     `<body>` (the `:root` default is inherited there), so read the computed value off `document.body`.
 */
import { test, expect } from '@playwright/test';
import { localePath } from './helpers';

/** The theme this run was booted with (mirrors the server `STOREFRONT_THEME`). */
const THEME = process.env.THEME === 'boutique' ? 'boutique' : 'default';

test.describe(`theme markers (${THEME})`, () => {
  test('cart affordance matches the theme (default → drawer button; boutique → page link)', async ({
    page,
  }) => {
    await page.goto(localePath('en'));
    // The header cart trigger carries an aria-label starting "Cart," in both themes (the localized
    // `cart.openCart` label); only its ELEMENT differs by affordance.
    const cartTrigger = page.getByRole(THEME === 'boutique' ? 'link' : 'button', {
      name: /cart,/i,
    });
    await expect(cartTrigger.first()).toBeVisible();

    if (THEME === 'boutique') {
      // page-link affordance: a plain locale-aware link to /cart, no dialog aria.
      await expect(cartTrigger.first()).toHaveAttribute('href', /\/cart$/);
      await expect(cartTrigger.first()).not.toHaveAttribute('aria-haspopup', 'dialog');
    } else {
      // drawer affordance: a button that opens the in-page dialog.
      await expect(cartTrigger.first()).toHaveAttribute('aria-haspopup', 'dialog');
    }
  });

  test('heading font reflects the theme (boutique → serif --font-heading; default → not serif)', async ({
    page,
  }) => {
    await page.goto(localePath('en'));
    // Read the resolved `--font-heading` custom property off <body> (where the theme vars are applied;
    // the `:root` default is inherited there for the default theme).
    const fontHeading = await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue('--font-heading').trim(),
    );
    if (THEME === 'boutique') {
      expect(fontHeading.toLowerCase()).toContain('serif');
    } else {
      // The default theme leaves --font-heading mirroring the sans stack (no serif override).
      expect(fontHeading.toLowerCase()).not.toContain('serif');
    }
  });
});
