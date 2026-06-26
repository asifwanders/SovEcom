/**
 * "Customer: register → place order → view order history" (storefront).
 *
 * Browser-level acceptance test for the full customer lifecycle across the auth and account areas:
 * a real signup through the registration UI, then the new customer's order appearing in their own
 * order history (list and detail) through the real account UI—the journey that jsdom/Vitest cannot run.
 *
 * Note: completing checkout through the browser terminates at the Stripe PaymentElement, which
 * requires a real Stripe secret the test stack does not have. There is also no admin/API endpoint
 * that creates an order for a customer (orders are created only by that Stripe-gated checkout).
 * The test is split: registration and order history view run through the real UI; the order is
 * created out of band by a direct DB insert that mirrors the seeded-order fixture shape
 * (`seedPaidOrderForCustomer`, fixtures.ts), bound to the freshly-registered customer's ID.
 * The UI assertions on the list and detail are the real acceptance signal.
 *
 * The test is rerunnable with a unique email and unique order number per run (no shared-state
 * collisions). It skips cleanly when the catalog/account fixture is absent (a local run without
 * `SEED_E2E_FIXTURE=1`) since the out-of-band order references the seeded product variant.
 * Runs at both desktop and mobile viewports.
 */
import { test, expect, type Page } from '@playwright/test';
import { localePath, loginAsCustomer } from './helpers';
import {
  hasFixture,
  seedConsentCookie,
  seedPaidOrderForCustomer,
  E2E_PRODUCT_TITLE,
  E2E_OOB_ORDER_TOTAL,
} from './fixtures';

/** A strong password that passes the min-12 length + breached-denylist policy (symbol for insurance). */
const REGISTER_PASSWORD = 'E2e-Lifecycle-2026!x';

/** A unique-per-run token (timestamp + random) so the email + order number never collide across reruns. */
function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Register a fresh customer through the REAL storefront registration UI (`/{locale}/register`). Pre-sets
 * the consent cookie so the CookieBanner never overlays the form. On success the form auto-logs-in and
 * `router.replace('/')`s off `/register`; we wait for that to confirm the real signup + auto-login leg
 * both succeeded. Then we CLEAR the browser cookies — dropping the httpOnly `SameSite=Strict` refresh
 * cookie that backs the auto-login session — so the session is genuinely ended and the later
 * `loginAsCustomer` exercises the UI LOGIN from scratch (not just a still-live auto-login session).
 */
async function registerViaUi(page: Page, email: string): Promise<void> {
  await seedConsentCookie(page);
  await page.goto(localePath('en', 'register'));

  await page.getByLabel(/email address/i).fill(email);
  await page.getByLabel(/name \(optional\)/i).fill('E2E Buyer');
  // The password field is labelled exactly "Password" (the confirm/new-password labels differ).
  await page.getByLabel(/^password$/i).fill(REGISTER_PASSWORD);
  await page.getByRole('button', { name: /create account/i }).click();

  // Full success leaves /register (auto-login → router.replace('/')). The wait proves the signup +
  // auto-login both succeeded (a failure would keep us on /register with an inline error).
  await page.waitForURL((url) => !url.pathname.includes('/register'), { timeout: 15_000 });

  // End the auto-login session: clearing cookies drops the httpOnly refresh cookie, so the subsequent
  // `loginAsCustomer` is a real, from-scratch UI login (it re-seeds the consent cookie itself).
  await page.context().clearCookies();
}

test.describe('customer lifecycle: register → (out-of-band paid order) → order history', () => {
  test.beforeEach(async ({ page }) => {
    const present = await hasFixture(page);
    test.skip(
      !present,
      'E2E catalog fixture not seeded (set SEED_E2E_FIXTURE=1) — order line cannot bind to the seeded variant.',
    );
  });

  test('a newly-registered customer sees their out-of-band paid order in history (list + detail)', async ({
    page,
  }) => {
    const suffix = uniqueSuffix();
    const email = `e2e-lifecycle-${suffix}@test.local`;
    const orderNumber = `E2E-LIFE-${suffix.toUpperCase()}`;

    // 1. REGISTER — real signup through the storefront UI (auto-logs-in, lands off /register).
    await registerViaUi(page, email);

    // 2. PLACE ORDER — out of band (UI checkout is Stripe-gated; no order-create API). A direct DB
    //    insert mirroring the seeded-order fixture, bound to THIS customer's id by email. Deterministic.
    seedPaidOrderForCustomer(email, orderNumber);

    // 3. VIEW HISTORY — log in through the real UI (fresh login, not the auto-login session) and assert
    //    the order shows in the customer's own order history.
    await loginAsCustomer(page, email, REGISTER_PASSWORD);
    await page.goto(localePath('en', 'account/orders'));

    // The order row appears: its number, the `paid` status, and the server-verbatim total (€28.89).
    const row = page.locator('tbody tr', { hasText: orderNumber });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/paid/i);
    await expect(row.getByTestId('order-total')).toHaveText(/28[.,]89/);
    // The total is rendered, never a raw minor-unit integer — guard the formatting invariant.
    await expect(row.getByTestId('order-total')).not.toHaveText(String(E2E_OOB_ORDER_TOTAL));

    // 4. DETAIL — open the order; the seeded tee line + the totals render (real account UI).
    await row.getByRole('link', { name: /view details/i }).click();
    await expect(page.getByTestId('order-detail')).toBeVisible();

    const itemRow = page.locator('tbody tr', { hasText: E2E_PRODUCT_TITLE });
    await expect(itemRow).toBeVisible();
    await expect(itemRow).toContainText('Medium');

    await expect(page.getByTestId('totals-grand')).toHaveText(/28[.,]89/);
  });
});
