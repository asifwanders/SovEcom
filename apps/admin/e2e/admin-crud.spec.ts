/**
 * Admin CRUD journeys on the harness: create a product (+ variant), a discount code, a shipping zone,
 * and a tax rate, each through the real UI against the live API, asserting it appears. Serial, owner.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, navTo } from './helpers';

// One login per FILE (not per test): the admin login is rate-limited, and these run serially on a
// shared page anyway (the in-memory token survives sidebar navigation, not a reload — see helpers).
test.describe.configure({ mode: 'serial' });
let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await login(page);
});
test.afterAll(async () => {
  await page.close();
});

test('creates a product with a variant and it appears in the list', async () => {
  await navTo(page, 'Products', /\/products$/);

  const title = `E2E Product ${Date.now()}`;
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(/\/products\/new$/);

  await page.locator('#title').fill(title);
  // Provide a slug explicitly: the form's zod treats '' as invalid (optional ⇒ undefined, not empty),
  // so a blank slug silently blocks submit.
  await page.locator('#slug').fill(`e2e-product-${Date.now()}`);
  await page.locator('#status').selectOption('published'); // published ⇒ indexed + listed/searchable
  // Variants start empty — add one and fill SKU / price / stock (currency defaults).
  await page.getByRole('button', { name: /Add variant/i }).click();
  const field = (label: string) => page.locator('div.space-y-1', { hasText: label });
  await field('SKU').getByRole('textbox').fill(`E2E-${Date.now()}`);
  await field('Title').getByRole('textbox').fill('Default'); // variant title is required (min 1)
  await field('Price (cents)').getByRole('spinbutton').fill('2500');
  await field('Currency').getByRole('textbox').fill('EUR');
  await field('Stock').getByRole('spinbutton').fill('10');

  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page).toHaveURL(/\/products$/, { timeout: 15_000 });
  // Filter to Published: this changes the react-query key → a FRESH fetch (the list visited before the
  // create is cached and the create doesn't invalidate it). The newest published product is on top.
  await page.locator('select').filter({ hasText: 'All statuses' }).selectOption('published');
  await expect(page.getByText(title)).toBeVisible({ timeout: 10_000 });
});

test('creates a discount code and it appears in the list', async () => {
  await navTo(page, 'Discounts', /\/discounts$/);

  const code = `E2E${Date.now()}`;
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#d-name').fill(`E2E Discount ${code}`);
  await dialog.locator('#d-code').fill(code);
  await dialog.locator('#d-value').fill('10');
  await dialog.getByRole('button', { name: /Create|Save/ }).click();

  await expect(dialog).toBeHidden();
  // The code renders in a <code> cell; exact match avoids the name cell that also contains it.
  await expect(page.getByText(code, { exact: true })).toBeVisible();
});

test('creates a shipping zone and it appears', async () => {
  await navTo(page, 'Shipping', /\/shipping$/);

  const name = `E2E Zone ${Date.now()}`;
  // The Zones section's add button is the first "Create" on the page (Rates has another).
  await page.getByRole('button', { name: 'Create', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('#z-name').fill(name);
  await dialog.locator('#z-countries').fill('FR, DE');
  await dialog.getByRole('button', { name: /Create|Save/ }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText(name)).toBeVisible();
});

test('creates a tax rate and it appears', async () => {
  await navTo(page, 'Taxes', /\/taxes$/);

  // Scope to the "Tax rates" section's Create (the heading's sibling) — this also waits for the
  // Taxes page to render, avoiding a transient match against the previous page during navigation.
  await page
    .getByRole('heading', { name: 'Tax rates' })
    .locator('..')
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Unique per run (country+region+name): the seed fills EU-27 rates and re-runs accumulate, so a
  // fixed country/region would collide on the (tenant, country, region) uniqueness.
  const ts = Date.now();
  const taxName = `E2E CH VAT ${ts}`;
  await dialog.locator('#tr-country').fill('CH');
  await dialog.locator('#tr-region').fill(`e2e-${ts}`);
  await dialog.locator('#tr-name').fill(taxName);
  await dialog.locator('#tr-rate').fill('0.0810');
  await dialog.getByRole('button', { name: /Create|Save/ }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText(taxName)).toBeVisible();
});
