/**
 * Accessibility gate for the transactional cart/checkout surfaces. Uses strict axe posture:
 * `seriousAxeViolations` fails on ANY serious/critical WCAG 2.1 A/AA violation. These are the
 * money/PII surfaces and get the SAME real-browser axe scan the catalog surfaces get. Runs at
 * BOTH viewports (the desktop + mobile Playwright projects).
 *
 * Covered: the cart page (with a real item + the discount form + shipping estimator), and each reachable
 * checkout step — email, address, shipping, review. The payment step's INNER form is a Stripe-hosted
 * iframe (out of our DOM + axe's reach), and reaching it needs a live clientSecret CI lacks, so a11y of
 * the payment STEP wrapper is covered by the in-house component Vitest+axe specs; here we scan
 * up to review.
 *
 * Fixture-guarded: skips cleanly on an empty catalog (no seeded product to add), mirroring the 3.7
 * empty-catalog posture — it activates fully when the fixture is seeded (CI seeds it).
 */
import { test, expect } from '@playwright/test';
import { seriousAxeViolations, formatViolations } from './helpers';
import {
  hasFixture,
  addInStockVariantToCart,
  gotoCartPageViaDrawer,
  gotoCheckoutViaDrawer,
} from './fixtures';

const REAL_ADDRESS = {
  name: 'Marie Dupont',
  line1: '10 Rue de Rivoli',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};

async function scan(page: import('@playwright/test').Page, label: string): Promise<void> {
  const violations = await seriousAxeViolations(page);
  expect(violations, `${label}: ${formatViolations(violations)}`).toEqual([]);
}

async function fillAddress(page: import('@playwright/test').Page): Promise<void> {
  await page.getByLabel(/full name/i).fill(REAL_ADDRESS.name);
  await page.getByLabel(/address line 1/i).fill(REAL_ADDRESS.line1);
  await page.getByLabel(/^city$/i).fill(REAL_ADDRESS.city);
  await page.getByLabel(/postal code/i).fill(REAL_ADDRESS.postalCode);
  await page.getByLabel(/^country$/i).selectOption(REAL_ADDRESS.country);
}

/** The theme this run was booted with (mirrors the server `STOREFRONT_THEME`; see playwright.config.ts). */
const THEME = process.env.THEME === 'boutique' ? 'boutique' : 'default';

test.describe('cart + checkout a11y', () => {
  // DEFAULT-THEME ONLY (3.9f B1): this scan drives the DRAWER cart affordance (gotoCartPageViaDrawer).
  // The boutique theme uses the `page-link` cart (no drawer), so skip on boutique — same rationale as
  // cart-checkout.spec.ts (affordance-agnostic cart flow is the tracked follow-up).
  test.skip(
    THEME !== 'default',
    'drawer-affordance flow; boutique page-link cart covered in follow-up',
  );

  // Runs at BOTH viewports. The mobile-header overlap that previously stranded the cart-drawer trigger
  // is fixed (Header.tsx — see cart-checkout.spec.ts), so the cart page + checkout-step axe scans now run
  // on mobile-chromium too. Skip only on an empty catalog (no fixture seeded).
  test.beforeEach(async ({ page }) => {
    const present = await hasFixture(page);
    test.skip(
      !present,
      'E2E catalog fixture not seeded (set SEED_E2E_FIXTURE=1) — a11y flow not exercised.',
    );
  });

  test('cart page (with an item) has no serious/critical axe violations', async ({ page }) => {
    await addInStockVariantToCart(page);
    await gotoCartPageViaDrawer(page);
    await expect(page.getByTestId('cart-line-item').first()).toBeVisible();
    await scan(page, 'cart page');
  });

  test('each checkout step (email → address → shipping → review) has no serious/critical axe violations', async ({
    page,
  }) => {
    await addInStockVariantToCart(page);
    await gotoCheckoutViaDrawer(page);

    // Email step.
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await scan(page, 'checkout email');
    await page.getByLabel(/email address/i).fill('guest@example.com');
    await page.getByRole('button', { name: /^continue$/i }).click();

    // Address step.
    await expect(page.getByText(/shipping address/i).first()).toBeVisible();
    await scan(page, 'checkout address');
    await fillAddress(page);
    await page.getByRole('button', { name: /^continue$/i }).click();

    // Shipping step.
    const rate = page.getByRole('radio').first();
    await expect(rate).toBeVisible({ timeout: 15_000 });
    await scan(page, 'checkout shipping');
    // Click (async server select), then wait for Continue to enable before advancing.
    await rate.click();
    const cont = page.getByRole('button', { name: /^continue$/i });
    await expect(cont).toBeEnabled({ timeout: 15_000 });
    await cont.click();

    // Review step.
    await expect(page.getByTestId('checkout-review')).toBeVisible();
    await scan(page, 'checkout review');
  });
});
