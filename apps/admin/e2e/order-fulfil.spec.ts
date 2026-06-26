/**
 * §3.14 scenario 11: "Admin: view order, fulfil, mark shipped". The order
 * fulfil→ship journey through the real admin UI against the live API: open a `paid` order's detail
 * page, drive it `paid → fulfilled → shipped`, asserting each status transition renders. Serial, owner.
 *
 * RE-RUNNABLE without a reseed: the seed (SEED_E2E_FIXTURE=1) creates a POOL of `paid` fixture orders
 * (`E2E-FULFIL-100x`). This spec filters the Orders list to `paid` and picks the FIRST fixture order
 * still in that status — so a prior run's order (now `shipped`, filtered out) is skipped and a fresh
 * `paid` one is driven every run. The full fulfil + ship buttons are therefore exercised on each run.
 *
 * NAVIGATION: like the other admin specs we navigate via the in-app UI (sidebar + a row click), never
 * `page.goto` after login — the in-memory token wouldn't survive a reload in this cross-origin harness
 * (see admin.spec.ts / helpers.ts). The Orders list has no search box; the status facet changes the
 * react-query key → a FRESH fetch (no stale cache), and the fixture orders carry a stable prefix.
 */
import { test, expect, type Page } from '@playwright/test';
import { login, navTo, sidebar } from './helpers';
import { FULFILL_ORDER_PREFIX } from './fixtures';

// One login per FILE (rate-limited) — serial on a shared page, like every admin journey spec.
test.describe.configure({ mode: 'serial' });
let page: Page;
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await login(page);
});
test.afterAll(async () => {
  await page.close();
});

/**
 * The status badge in the order-detail <h1>. The page renders the raw status (swapping `_`→space) and
 * only CAPITALISES via CSS (`capitalize`), so the DOM text Playwright matches is lowercase ("paid").
 */
const statusBadge = (p: Page) => p.locator('h1').getByText(/^(paid|fulfilled|shipped|delivered)$/);

/** Confirm a status transition through the "Confirm: …" dialog the order-detail page opens. */
async function confirmTransition(p: Page, buttonLabel: string) {
  await p.getByRole('button', { name: buttonLabel, exact: true }).click();
  const dialog = p.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('views a paid order, fulfils it, then marks it shipped', async () => {
  await navTo(page, 'Orders', /\/orders$/);

  // Filter to `paid`: a fresh react-query fetch (the unfiltered list visited above is cached and a
  // transition wouldn't invalidate it), and it hides any fixture order a previous run already shipped.
  await page.getByLabel('Filter by status').selectOption('paid');

  // The first fixture fulfilment order still in `paid` (stable prefix). Fail loudly if the pool is
  // exhausted (a real signal to reseed) rather than silently passing on a non-fixture row.
  const row = page.getByRole('row').filter({ hasText: FULFILL_ORDER_PREFIX }).first();
  await expect(row, 'no paid E2E-FULFIL-* order left — reseed the fixture pool').toBeVisible({
    timeout: 10_000,
  });
  const orderNumber = (await row.locator('td').first().innerText()).trim();
  await row.click();

  // On the detail page: the right order, currently Paid.
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: new RegExp(orderNumber) })).toBeVisible();
  await expect(statusBadge(page)).toHaveText('paid');

  // paid → fulfilled.
  await confirmTransition(page, 'Mark fulfilled');
  await expect(statusBadge(page)).toHaveText('fulfilled', { timeout: 10_000 });

  // fulfilled → shipped.
  await confirmTransition(page, 'Mark shipped');
  await expect(statusBadge(page)).toHaveText('shipped', { timeout: 10_000 });

  // The shell is still mounted (no bounce to login / blank error).
  await expect(sidebar(page)).toBeVisible();
});
