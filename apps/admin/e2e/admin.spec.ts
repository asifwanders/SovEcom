/**
 * admin-SPA end-to-end. The admin app had ZERO browser coverage; this is the
 * first real-UI journey: a true login against the live API (cross-origin, Bearer), the primary admin
 * pages rendering for the owner, and a write path (create a category, see it appear). Runs against a
 * SEED_E2E_FIXTURE-seeded API (admin@default.local with a real password, store installed).
 *
 * NOTE on navigation: the admin keeps its access token in memory (zustand). In this cross-origin
 * harness (admin :4173, API :3000) the httpOnly refresh cookie is cross-site, so a FULL reload
 * (`page.goto`) can't restore the session — in prod the admin is same-origin (Caddy) and reload works.
 * So after login we navigate via the in-app sidebar (client-side routing), which keeps the token AND
 * is the recommended Playwright practice (drive the app, not the URL bar). Other admin CRUD journeys
 * (product+variants, shipping/tax, discounts, order fulfil→ship) build on this harness — next 3.14.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, sidebar, navTo } from './helpers';

// One login per FILE (rate-limited), serial on a shared page — see admin-crud.spec.ts / helpers.
test.describe.configure({ mode: 'serial' });
let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await login(page);
});
test.afterAll(async () => {
  await page.close();
});

test('logs in as the owner and lands on the dashboard', async () => {
  await expect(sidebar(page)).toBeVisible();
  await expect(sidebar(page).getByRole('link', { name: 'Products' })).toBeVisible();
});

test('every primary admin page renders for the owner (no blank/error)', async () => {
  const pages: [string, RegExp][] = [
    ['Products', /\/products$/],
    ['Categories', /\/categories$/],
    ['Discounts', /\/discounts$/],
    ['Shipping', /\/shipping$/],
    ['Taxes', /\/taxes$/],
    ['Analytics', /\/analytics$/],
  ];
  for (const [name, re] of pages) {
    await navTo(page, name, re);
    await expect(page).not.toHaveURL(/\/login$/); // not bounced to login
    await expect(sidebar(page)).toBeVisible(); // shell still mounted
  }
});

test('creates a category and it appears in the list', async () => {
  await navTo(page, 'Categories', /\/categories$/);

  const name = `E2E Category ${Date.now()}`;
  await page.getByRole('button', { name: /New category/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // The dialog's first textbox is Name (Slug auto-generates from it).
  await dialog.getByRole('textbox').first().fill(name);
  await dialog.getByRole('button', { name: 'Create' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText(name)).toBeVisible();
});
