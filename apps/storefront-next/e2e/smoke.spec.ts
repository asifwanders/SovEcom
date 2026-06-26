/**
 * Smoke / interaction E2E. Verifies the storefront
 * boots and its chrome works in a real browser, at BOTH viewports (the two Playwright projects):
 *   - home renders with the header brand + nav + footer;
 *   - the dark-mode toggle flips the `.dark` class on `<html>` and persists to the `theme` cookie;
 *   - the language switcher swaps `/en` ↔ `/fr` and updates `<html lang>`;
 *   - `/robots.txt` + `/sitemap.xml` respond 200 with the expected content;
 *   - `/search` is `noindex` (its robots meta) while the rest of the catalog is indexable.
 *
 * Catalog-independent — every assertion targets always-present chrome / static routes, so it passes
 * with the empty-catalog CI seed (see e2e/README).
 */
import { test, expect } from '@playwright/test';
import { localePath, dismissCookieBanner } from './helpers';

test.describe('storefront smoke', () => {
  test('home renders header brand, nav and footer', async ({ page }, testInfo) => {
    await page.goto(localePath('en'));
    // Header is the sticky top landmark; the brand link points at the locale home.
    await expect(page.locator('header')).toBeVisible();

    // ALWAYS-present header affordances (every viewport): the CategoryNav "Browse" trigger (categories
    // entry point), the Search link, and the cart badge. These are the chrome a mobile shopper relies on.
    await expect(page.getByRole('navigation', { name: /category navigation/i })).toBeVisible();
    await expect(page.locator('header nav a[href$="/search"]').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /cart,/i })).toBeVisible();

    // The Products and Categories flat links are hidden below the `sm` breakpoint (they overflowed and
    // overlapped the cart badge on small viewports; on mobile they live in the Browse drawer). Assert
    // them visible only at the desktop viewport; hidden on mobile.
    const productsLink = page.locator('header nav a[href$="/products"]').first();
    const categoriesLink = page.locator('header nav a[href$="/category"]').first();
    if (testInfo.project.name === 'mobile-chromium') {
      await expect(productsLink).toBeHidden();
      await expect(categoriesLink).toBeHidden();
    } else {
      await expect(productsLink).toBeVisible();
      await expect(categoriesLink).toBeVisible();
    }

    await expect(page.locator('main#main-content')).toBeVisible();
    await expect(page.locator('footer')).toBeVisible();
    // The hero heading is the page's single h1.
    await expect(page.locator('main h1').first()).toBeVisible();
  });

  test('dark-mode toggle flips the .dark class and persists the cookie', async ({ page }) => {
    await page.goto(localePath('en'));
    // The first-visit cookie banner overlays the footer (where the toggle lives); dismiss it so the
    // footer ThemeToggle is actionable (not covered by the fixed-bottom banner).
    await dismissCookieBanner(page);
    const html = page.locator('html');
    const toggle = page.getByRole('button', { name: /dark|light|theme/i }).first();
    await expect(toggle).toBeVisible();

    const startedDark = await html.evaluate((el) => el.classList.contains('dark'));
    await toggle.click();
    // The class must have flipped relative to the start state.
    await expect
      .poll(async () => html.evaluate((el) => el.classList.contains('dark')))
      .toBe(!startedDark);

    // The choice persists to the `theme` cookie (SSR-readable; the no-FOUC script reads it).
    const cookies = await page.context().cookies();
    const themeCookie = cookies.find((c) => c.name === 'theme');
    expect(themeCookie, 'theme cookie should be set after toggling').toBeTruthy();
    expect(['light', 'dark']).toContain(themeCookie!.value);
  });

  test('language switcher swaps locale and updates <html lang>', async ({ page }) => {
    await page.goto(localePath('en'));
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    // Dismiss the first-visit cookie banner so it does not obscure the footer language switcher.
    await dismissCookieBanner(page);

    // The switcher is a labelled <select> in the footer.
    const select = page.locator('footer select').first();
    await expect(select).toBeVisible();
    await select.selectOption('fr');

    // The navigation lands on the /fr home and <html lang> follows.
    await expect(page).toHaveURL(/\/fr(\/|$)/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  });

  test('robots.txt responds 200 and disallows the search path', async ({ page }) => {
    const res = await page.request.get('/robots.txt');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/User-Agent:/i);
    // The internal search results path is disallowed (thin/duplicate content).
    expect(body).toMatch(/Disallow:\s*\/\*\/search/i);
    // The absolute sitemap URL is referenced for discovery.
    expect(body).toMatch(/Sitemap:\s*https?:\/\/\S+\/sitemap\.xml/i);
  });

  test('sitemap.xml responds 200 and lists the static locale routes', async ({ page }) => {
    const res = await page.request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<urlset');
    // Both locale homes are always present even with an empty catalog.
    expect(xml).toMatch(/\/en(<|")/);
    expect(xml).toMatch(/\/fr(<|")/);
  });

  test('search results route is noindex', async ({ page }) => {
    await page.goto(localePath('en', 'search'));
    // The page-level robots meta marks search noindex (follow) — query permutations are not indexed.
    const robots = page.locator('meta[name="robots"]');
    await expect(robots).toHaveAttribute('content', /noindex/i);
  });
});
