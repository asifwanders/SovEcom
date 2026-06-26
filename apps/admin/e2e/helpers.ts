/**
 * shared admin-E2E helpers. Login + sidebar (client-side) navigation, used
 * by every admin journey spec. See admin.spec.ts header for the cross-origin token caveat (we never
 * `page.goto` after login — the in-memory token wouldn't survive a reload in this harness).
 */
import { expect, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './fixtures';

export async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#email').fill(ADMIN_EMAIL);
  await page.locator('#password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
}

/** The sidebar landmark (<aside aria-label="Main navigation">), distinct from the breadcrumb nav. */
export const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Main navigation' });

/** Navigate via the sidebar (client-side routing — keeps the in-memory token alive). */
export async function navTo(page: Page, linkName: string, pathRe: RegExp) {
  await sidebar(page).getByRole('link', { name: linkName, exact: true }).click();
  await expect(page).toHaveURL(pathRe);
}
