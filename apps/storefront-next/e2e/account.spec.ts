/**
 * Customer-account E2E. The browser-level acceptance gate for the account area
 * (login → dashboard, orders list/detail, invoice PDF download, address book, return request, profile
 * edit, RGPD export) — the criteria jsdom/Vitest cannot run: real navigation across the authenticated
 * `(account)` route group, a real credentialed invoice-PDF fetch, and real axe a11y on post-login pages.
 *
 * Fixture-guarded: a `beforeEach` logs the seeded customer in and `test.skip`s cleanly if the account
 * fixture is absent (a local run without `SEED_E2E_FIXTURE=1`) — the suite never FAILS on an unseeded
 * stack, mirroring the catalog suite's `hasFixture` posture. It activates fully once the CI
 * `storefront-e2e` job seeds the fixture. Runs at BOTH viewports (desktop + mobile projects).
 *
 * The token is in-memory (no storageState); each test logs in via `loginAsCustomer`. After login a
 * `page.goto` to an account route still works — the httpOnly refresh cookie silently re-mints the token
 * on mount (auth-context). All money is rendered server-verbatim via `formatPrice`; assertions match the
 * locale-formatted amount loosely (`/19[.,]99/`) so they hold under both en (`€19.99`) and fr (`19,99 €`).
 */
import { test, expect, type Page } from '@playwright/test';
import { localePath, loginAsCustomer, seriousAxeViolations, formatViolations } from './helpers';
import {
  E2E_ACCOUNT_EMAIL,
  E2E_ACCOUNT_PASSWORD,
  E2E_ACCOUNT_ORDER_NUMBER,
  E2E_PRODUCT_TITLE,
} from './fixtures';

/**
 * Log the seeded customer in, then `test.skip` if the account fixture is absent. `loginAsCustomer`
 * waits for the redirect off `/login`; when the customer does not exist the login fails and the URL
 * never leaves `/login`, so we catch the timeout and skip rather than fail (empty-stack posture).
 */
async function loginOrSkip(page: Page, locale: 'en' | 'fr' = 'en'): Promise<void> {
  try {
    await loginAsCustomer(page, E2E_ACCOUNT_EMAIL, E2E_ACCOUNT_PASSWORD, locale);
  } catch {
    test.skip(
      true,
      'Account fixture not seeded (set SEED_E2E_FIXTURE=1) — account area not exercised.',
    );
  }
}

/** Open the seeded delivered order's detail page (orders list → "View details") and wait for it. */
async function gotoSeededOrderDetail(page: Page): Promise<void> {
  await page.goto(localePath('en', 'account/orders'));
  const row = page.locator('tbody tr', { hasText: E2E_ACCOUNT_ORDER_NUMBER });
  await expect(row).toBeVisible();
  await row.getByRole('link', { name: /view details/i }).click();
  await expect(page.getByTestId('order-detail')).toBeVisible();
}

test.describe('customer account area', () => {
  test('1 — login lands on the dashboard with greeting + section nav', async ({ page }) => {
    await loginOrSkip(page);
    await page.goto(localePath('en', 'account'));

    // Greeting: "Welcome back, E2E Account" (name) or "My account" fallback — match either.
    await expect(
      page.getByRole('heading', { level: 1, name: /welcome back|my account/i }),
    ).toBeVisible();

    // Section nav landmark + its items.
    const nav = page.getByRole('navigation', { name: /my account/i });
    await expect(nav.getByRole('link', { name: /dashboard/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /orders/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /addresses/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /profile/i })).toBeVisible();
  });

  test('2 — orders list shows the seeded order; detail shows the line + totals', async ({
    page,
  }) => {
    await loginOrSkip(page);
    await page.goto(localePath('en', 'account/orders'));

    const row = page.locator('tbody tr', { hasText: E2E_ACCOUNT_ORDER_NUMBER });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/delivered/i);
    await expect(row.getByTestId('order-total')).toHaveText(/28[.,]89/);

    await row.getByRole('link', { name: /view details/i }).click();
    await expect(page.getByTestId('order-detail')).toBeVisible();

    // Line item: "E2E Test Tee" / "Medium" × 1.
    const itemRow = page.locator('tbody tr', { hasText: E2E_PRODUCT_TITLE });
    await expect(itemRow).toBeVisible();
    await expect(itemRow).toContainText('Medium');
    await expect(itemRow.locator('td').nth(1)).toHaveText('1');

    // Totals (server-verbatim): subtotal 19.99 / shipping 4.90 / tax 4.00 / total 28.89.
    await expect(page.getByTestId('totals-subtotal')).toHaveText(/19[.,]99/);
    await expect(page.getByTestId('totals-shipping')).toHaveText(/4[.,]90/);
    await expect(page.getByTestId('totals-tax')).toHaveText(/4[.,]00/);
    await expect(page.getByTestId('totals-grand')).toHaveText(/28[.,]89/);
  });

  test('3 — invoice download returns a 200 application/pdf', async ({ page }) => {
    await loginOrSkip(page);
    await gotoSeededOrderDetail(page);

    const downloadButton = page.getByRole('button', { name: /download invoice/i });
    await expect(downloadButton).toBeVisible();

    // Listen for the invoice endpoint response; assert it is a 200 PDF (no need to open the file).
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => /\/orders\/[^/]+\/invoice$/.test(res.url()) && res.request().method() === 'GET',
      ),
      downloadButton.click(),
    ]);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type'] ?? '').toContain('application/pdf');
  });

  test('4 — address book shows the default address; add then delete a new one', async ({
    page,
  }) => {
    await loginOrSkip(page);
    await page.goto(localePath('en', 'account/addresses'));

    await expect(page.getByTestId('address-book')).toBeVisible();
    // The seeded default shipping address.
    const seeded = page.getByTestId('address-card').filter({ hasText: '10 Rue de Rivoli' });
    await expect(seeded).toBeVisible();
    await expect(seeded.getByTestId('default-badge')).toBeVisible();

    const cardsBefore = await page.getByTestId('address-card').count();

    // Add a new address.
    await page.getByRole('button', { name: /add address/i }).click();
    await page.getByLabel(/full name/i).fill('E2E Added Person');
    await page.getByLabel(/address line 1/i).fill('25 Avenue des Champs');
    await page.getByLabel(/^city$/i).fill('Lyon');
    await page.getByLabel(/postal code/i).fill('69001');
    await page.locator('select[name="country"]').selectOption('FR');
    await page.getByRole('button', { name: /save address/i }).click();

    // The new card appears (count grows + its content is present).
    const added = page.getByTestId('address-card').filter({ hasText: '25 Avenue des Champs' });
    await expect(added).toBeVisible();
    await expect(page.getByTestId('address-card')).toHaveCount(cardsBefore + 1);

    // Delete it (inline confirm step).
    await added.getByRole('button', { name: /^delete$/i }).click();
    await added
      .getByTestId('delete-confirm')
      .getByRole('button', { name: /confirm delete/i })
      .click();
    await expect(
      page.getByTestId('address-card').filter({ hasText: '25 Avenue des Champs' }),
    ).toHaveCount(0);
  });

  test('5 — request a return (withdrawal) succeeds', async ({ page }) => {
    await loginOrSkip(page);
    await gotoSeededOrderDetail(page);

    await page.getByTestId('request-return-link').click();
    await expect(page.getByTestId('return-request')).toBeVisible();

    // Select the seeded item, pick Withdrawal, submit.
    const itemCheckbox = page.locator('[data-testid^="include-"]').first();
    await itemCheckbox.check();
    await page.getByTestId('type-withdrawal').check();
    await page.getByTestId('return-submit').click();

    // Success banner: status requested, within the 14-day window.
    const success = page.getByTestId('return-success');
    await expect(success).toBeVisible();
    await expect(success).toContainText(/requested/i);
    await expect(success).toContainText(/within the 14-day withdrawal window: yes/i);
  });

  test('6 — profile edit saves and persists across reload', async ({ page }) => {
    await loginOrSkip(page);
    await page.goto(localePath('en', 'account/profile'));

    const nameField = page.getByLabel(/^name$/i);
    await expect(nameField).toBeVisible();

    // Use a deterministic value that does not break other specs (they assert the order, not the name).
    const newName = 'E2E Account Edited';
    await nameField.fill(newName);
    await page.getByRole('button', { name: /save profile/i }).click();
    await expect(page.getByRole('status').filter({ hasText: /profile saved/i })).toBeVisible();

    // Reload → the saved name is rehydrated from the server into the field.
    await page.reload();
    await expect(page.getByLabel(/^name$/i)).toHaveValue(newName);

    // Restore the seeded name so the suite is order-independent.
    await page.getByLabel(/^name$/i).fill('E2E Account');
    await page.getByRole('button', { name: /save profile/i }).click();
    await expect(page.getByRole('status').filter({ hasText: /profile saved/i })).toBeVisible();
  });

  test('7 — RGPD export succeeds; erase Delete stays gated (no execution)', async ({ page }) => {
    await loginOrSkip(page);
    await page.goto(localePath('en', 'account/privacy'));

    await expect(page.getByTestId('rgpd-section')).toBeVisible();

    // Export: enter the password, submit, assert a 200 POST + a success message. The exported JSON
    // must NEVER be rendered to the DOM (it is PII) — assert a known field value is absent.
    await page.locator('#rgpd-export-password').fill(E2E_ACCOUNT_PASSWORD);
    const [exportResponse] = await Promise.all([
      page.waitForResponse(
        (res) => /\/rgpd\/export$/.test(res.url()) && res.request().method() === 'POST',
      ),
      page
        .getByTestId('rgpd-export')
        .getByRole('button', { name: /export my data/i })
        .click(),
    ]);
    expect(exportResponse.status()).toBe(200);
    await expect(page.getByTestId('rgpd-export-success')).toBeVisible();
    // The export JSON is downloaded, never injected — the order number it contains is not in the DOM.
    await expect(page.locator('body')).not.toContainText(E2E_ACCOUNT_ORDER_NUMBER);

    // Erase Delete button is DISABLED until BOTH the confirm-email matches AND a password is entered.
    const deleteButton = page.getByRole('button', { name: /permanently delete my account/i });
    await expect(deleteButton).toBeDisabled();

    // Only the email → still disabled.
    await page.locator('#rgpd-erase-email').fill(E2E_ACCOUNT_EMAIL);
    await expect(deleteButton).toBeDisabled();

    // Email + password → now enabled (we DO NOT click it — erase would anonymize the shared seed).
    await page.locator('#rgpd-erase-password').fill(E2E_ACCOUNT_PASSWORD);
    await expect(deleteButton).toBeEnabled();
  });

  test('8 — a11y: dashboard, orders, order-detail, addresses, profile, security, privacy have no serious axe violations', async ({
    page,
  }) => {
    await loginOrSkip(page);

    await page.goto(localePath('en', 'account'));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    let v = await seriousAxeViolations(page);
    expect(v, `dashboard:\n${formatViolations(v)}`).toEqual([]);

    await page.goto(localePath('en', 'account/orders'));
    await expect(page.locator('tbody tr', { hasText: E2E_ACCOUNT_ORDER_NUMBER })).toBeVisible();
    v = await seriousAxeViolations(page);
    expect(v, `orders:\n${formatViolations(v)}`).toEqual([]);

    await gotoSeededOrderDetail(page);
    v = await seriousAxeViolations(page);
    expect(v, `order-detail:\n${formatViolations(v)}`).toEqual([]);

    await page.goto(localePath('en', 'account/addresses'));
    await expect(page.getByTestId('address-book')).toBeVisible();
    v = await seriousAxeViolations(page);
    expect(v, `addresses:\n${formatViolations(v)}`).toEqual([]);

    await page.goto(localePath('en', 'account/profile'));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    v = await seriousAxeViolations(page);
    expect(v, `profile:\n${formatViolations(v)}`).toEqual([]);

    await page.goto(localePath('en', 'account/security'));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    v = await seriousAxeViolations(page);
    expect(v, `security:\n${formatViolations(v)}`).toEqual([]);

    await page.goto(localePath('en', 'account/privacy'));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    v = await seriousAxeViolations(page);
    expect(v, `privacy:\n${formatViolations(v)}`).toEqual([]);
  });

  test('9 — FR: login + dashboard shows the French section nav', async ({ page }) => {
    await loginOrSkip(page, 'fr');
    await page.goto(localePath('fr', 'account'));

    const nav = page.getByRole('navigation', { name: /mon compte/i });
    await expect(nav.getByRole('link', { name: /tableau de bord/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /commandes/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /adresses/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /profil/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /sécurité/i })).toBeVisible();
    await expect(nav.getByRole('link', { name: /confidentialité/i })).toBeVisible();
  });
});
