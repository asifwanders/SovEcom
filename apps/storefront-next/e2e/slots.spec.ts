/**
 * Module slot runtime E2E. Verifies the security-critical guarantee that a module slot is invisible
 * and harmless when no module resolves it, and that the page renders unchanged around it.
 *
 * In CI no modules are enabled, so `GET /store/v1/slots` returns an empty object and every `<Slot>`
 * (home-page-bottom, product-detail-*, product-card-actions) renders nothing. This is the fail-closed
 * end-state to which a failing, empty, or conflicted module degrades: the slot contributes no DOM,
 * no widget marker, and the page chrome and content render normally. The tests are catalog-independent
 * (targeting always-present chrome and the widget markers the runtime would emit) and pass with the
 * empty-catalog CI seed.
 */
import { test, expect } from '@playwright/test';
import { localePath } from './helpers';

test.describe('module slot runtime (no module bound ⇒ invisible)', () => {
  test('home renders with NO slot widget and NO island when no module is bound', async ({
    page,
  }) => {
    const response = await page.goto(localePath('en'));
    // The page itself must render (200) — a module never breaks the page.
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator('header')).toBeVisible();

    // No widget reached the DOM (no module resolves a slot in CI): neither a rendered widget nor a
    // personalized client-island marker is present anywhere on the page.
    await expect(page.locator('[data-widget]')).toHaveCount(0);
    await expect(page.locator('[data-slot-island]')).toHaveCount(0);

    // The home body still renders its own content around the (empty) home-page-bottom slot.
    await expect(page.locator('footer')).toBeVisible();
  });

  test('the home-page-bottom slot injects no script/style/iframe into the page', async ({
    page,
  }) => {
    await page.goto(localePath('en'));
    // Fail-closed posture: a module can never ship active markup. With no module bound there is, of
    // course, none — this pins the invariant at the rendered-page level (no module-injected actives).
    const injected = page.locator('main script, main iframe, main object, main embed');
    await expect(injected).toHaveCount(0);
  });

  test('an unknown product route resolves without a 5xx (slots never break routing)', async ({
    page,
  }) => {
    // The PDP slots render only PAST the notFound() guard, so an unknown slug must still resolve to the
    // not-found UI (never a 500) — a module slot can never crash or mask routing.
    const response = await page.goto(localePath('en', 'product/__definitely-not-a-real-slug__'));
    expect(response?.status()).toBeLessThan(500);
    // No module widget / island leaked onto the not-found page either.
    await expect(page.locator('[data-widget]')).toHaveCount(0);
    await expect(page.locator('[data-slot-island]')).toHaveCount(0);
  });

  test('the per-card product-card-actions slot is harmless on a catalog grid surface', async ({
    page,
  }) => {
    // A per-card `<Slot name="product-card-actions">` is present on every product grid (home, products,
    // category, search). With no module bound in CI the per-card slot renders nothing—the products index
    // still renders its chrome and empty-but-valid state, and no widget/island leaks. This test pins the
    // fail-closed invariant at the rendered-page level: the per-card slot does not break a grid surface.
    const response = await page.goto(localePath('en', 'products'));
    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator('header')).toBeVisible();
    await expect(page.locator('footer')).toBeVisible();
    await expect(page.locator('[data-widget]')).toHaveCount(0);
    await expect(page.locator('[data-slot-island]')).toHaveCount(0);
  });
});
