/**
 * Transactional cart → checkout E2E. The browser-level acceptance gate
 * for the 3.8 money path that jsdom/Vitest cannot run: a real add-to-cart from the seeded PDP, the
 * header badge + slide-out drawer, the cart page rendering the SNAPSHOTTED product NAME (never a UUID),
 * and the full checkout flow driven up to the Stripe Payment Element boundary.
 *
 * Fixture-guarded: every test `test.skip`s cleanly when the deterministic catalog fixture is absent (a
 * local run without `SEED_E2E_FIXTURE=1`), so this never fails on an empty catalog — it activates fully
 * the moment the fixture is seeded (the CI `storefront-e2e` job seeds it). Runs at BOTH viewports (the
 * desktop + mobile Playwright projects).
 *
 * Stripe in CI: the API needs a Stripe SECRET key to mint a real PaymentIntent clientSecret, which CI
 * does NOT have. So the DEFAULT run asserts the flow REACHES the payment step UI (review → proceed →
 * the payment step mounts / attempts the intent); the LIVE PaymentElement mount + confirm is gated
 * behind `E2E_STRIPE_LIVE=1` (a real Stripe test SECRET in the API) and `test.skip`ped otherwise. See
 * the "live payment (gated)" test below.
 */
import { test, expect } from '@playwright/test';
import { localePath } from './helpers';
import {
  E2E_PRODUCT_TITLE,
  E2E_OUT_OF_STOCK_OPTION,
  E2E_PRODUCT_SLUG,
  hasFixture,
  seedConsentCookie,
  addInStockVariantToCart,
  cartBadge,
  openCartDrawer,
  gotoCartPageViaDrawer,
  gotoCheckoutViaDrawer,
} from './fixtures';

/** A complete, REAL shipping address for the checkout address step (never the estimator placeholder). */
const REAL_ADDRESS = {
  name: 'Marie Dupont',
  line1: '10 Rue de Rivoli',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};

/** The theme this run was booted with (mirrors the server `STOREFRONT_THEME`; see playwright.config.ts). */
const THEME = process.env.THEME === 'boutique' ? 'boutique' : 'default';

test.describe('transactional cart → checkout', () => {
  // DEFAULT-THEME ONLY (3.9f B1): this flow drives the DRAWER cart affordance (openCartDrawer /
  // gotoCartPageViaDrawer). The boutique theme uses the `page-link` cart (a plain link to /cart, no
  // drawer), so these steps don't apply there — skip on boutique. Making the cart flow affordance-
  // agnostic (drawer AND page-link) is the tracked follow-up; the cross-theme guarantee here is the
  // smoke / a11y / json-ld / theme / visual coverage, which IS theme-agnostic.
  test.skip(
    THEME !== 'default',
    'drawer-affordance flow; boutique page-link cart covered in follow-up',
  );
  // Runs at BOTH viewports (desktop-chromium + mobile-chromium / Pixel 5). The mobile-header overlap
  // that previously stranded the cart badge is FIXED (Header.tsx — Products/Categories are hidden < sm
  // so the nav row no longer overflows ~393px and the CartBadge is reliably tappable), so the full
  // transactional money path now runs on mobile too.
  // Skip only on an empty catalog (no fixture seeded).
  test.beforeEach(async ({ page }) => {
    const present = await hasFixture(page);
    test.skip(
      !present,
      'E2E catalog fixture not seeded (set SEED_E2E_FIXTURE=1) — flow not exercised.',
    );
  });

  test('add to cart from the PDP updates the badge and opens the drawer with the product NAME', async ({
    page,
  }) => {
    await addInStockVariantToCart(page);

    // The badge accessible name embeds the count ("Cart, 1 item") — the item registered.
    await expect(cartBadge(page)).toHaveAccessibleName(/cart,\s*1\s*item/i);

    // Open the drawer; the line renders the snapshotted product TITLE (not a raw variant UUID).
    await openCartDrawer(page);
    const dialog = page.getByRole('dialog', { name: /your cart/i });
    const lineTitle = dialog.getByTestId('line-title').first();
    await expect(lineTitle).toHaveText(E2E_PRODUCT_TITLE);
    // Never a UUID (defensive: the snapshot must carry the human name).
    await expect(lineTitle).not.toHaveText(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // A formatted EUR price is shown on the line (server minor units; "× 1" quantity form).
    await expect(dialog.getByTestId('cart-line-item').first()).toContainText(/€|EUR/);
  });

  test('the cart PAGE shows the product name, price and a working quantity stepper', async ({
    page,
  }) => {
    await addInStockVariantToCart(page);
    await gotoCartPageViaDrawer(page);

    // Line renders the snapshotted product name linked to its PDP — never a UUID.
    const lineTitle = page.getByTestId('line-title').first();
    await expect(lineTitle).toHaveText(E2E_PRODUCT_TITLE);
    await expect(page.getByTestId('cart-line-item').first()).toContainText(/€|EUR/);

    // Increment quantity → the server re-fetches and the live qty value updates to 2.
    const qty = page.getByTestId('line-qty').first();
    await expect(qty).toHaveText('1');
    await page
      .getByRole('button', { name: /increase quantity/i })
      .first()
      .click();
    await expect(qty).toHaveText('2');
  });

  test('out-of-stock variant disables add-to-cart and never adds', async ({ page }) => {
    await seedConsentCookie(page);
    await page.goto(localePath('en', `product/${E2E_PRODUCT_SLUG}`));

    // Choose the SOLD-OUT size → the add button shows the out-of-stock label and is disabled.
    await page
      .getByLabel(E2E_OUT_OF_STOCK_OPTION.axis, { exact: true })
      .selectOption(E2E_OUT_OF_STOCK_OPTION.value);
    const addButton = page.getByRole('button', { name: /out of stock/i });
    await expect(addButton).toBeVisible();
    await expect(addButton).toBeDisabled();
    // The badge stays at zero — nothing was added.
    await expect(cartBadge(page)).toHaveAccessibleName(/cart,\s*empty/i);
  });

  test('checkout flow reaches the payment step (guest → address → shipping → review → payment)', async ({
    page,
  }) => {
    await addInStockVariantToCart(page);
    await gotoCheckoutViaDrawer(page);

    // Step 1 — guest email.
    await page.getByLabel(/email address/i).fill('guest@example.com');
    await page.getByRole('button', { name: /^continue$/i }).click();

    // Step 2 — REAL shipping address (overwrites any estimator placeholder). Wait for
    // the address step to render (the email→address advance is async) before filling.
    await expect(page.getByRole('button', { name: /address/i })).toHaveAttribute(
      'aria-current',
      'step',
    );
    await fillAddress(page);
    await page.getByRole('button', { name: /^continue$/i }).click();

    // Step 3 — shipping method: the seeded FR Colissimo rate loads; choose it. (Wait for the shipping
    // step, then for the rate radio — the rates are fetched async on the step's mount.)
    await expect(page.getByRole('button', { name: /shipping/i })).toHaveAttribute(
      'aria-current',
      'step',
    );
    const rateRadio = page.getByRole('radio').first();
    await expect(rateRadio).toBeVisible({ timeout: 15_000 });
    // Click (not `.check()`): selecting a rate is an ASYNC server mutation; the radio only reflects
    // `checked` after the cart re-fetch, which `.check()`'s synchronous state assertion would miss.
    await rateRadio.click();
    // Continue enables only once the cart carries the chosen `shippingRateId` (server-confirmed).
    const shippingContinue = page.getByRole('button', { name: /^continue$/i });
    await expect(shippingContinue).toBeEnabled({ timeout: 15_000 });
    await shippingContinue.click();

    // Step 4 — review: the snapshotted product name is shown (never a UUID); proceed to payment.
    const review = page.getByTestId('checkout-review');
    await expect(review).toBeVisible();
    await expect(page.getByTestId('review-line-name').first()).toHaveText(E2E_PRODUCT_TITLE);
    await page.getByTestId('proceed-to-payment').click();

    // Step 5 — the payment step is REACHED. Without a Stripe SECRET in CI the API can't mint a real
    // clientSecret, so the step legitimately resolves to one of: the mounted PaymentElement boundary
    // (`checkout-payment`, if a test secret IS configured), the "preparing" state, or the generic /
    // config error notice. ALL of these prove we transitioned PAST review INTO the payment step — which
    // is the gated, non-live assertion. We assert the payment step's progress marker is now
    // current AND one of the payment-step surfaces is present.
    await expect(page.getByRole('button', { name: /payment/i })).toHaveAttribute(
      'aria-current',
      'step',
    );
    const paymentSurface = page
      .getByTestId('checkout-payment')
      .or(page.getByTestId('payment-loading'))
      .or(page.getByTestId('payment-error'))
      .or(page.getByTestId('payment-config-error'));
    await expect(paymentSurface.first()).toBeVisible({ timeout: 15_000 });
  });

  /**
   * A placeholder '—' address can never reach a created order. The API checkout validation only
   * checks the shipping address EXISTS, not
   * that it is REAL (`orders.service.ts validateCheckoutReady`), so the only enforcement of the
   * non-placeholder rule lives in the STOREFRONT flow guard (`canReachStep` rejects an
   * `isPlaceholderAddress` cart) + the payment-boundary backstop. The strongest available guarantee is
   * therefore this UI-level assertion: drive the cart shipping ESTIMATOR (which POSTs the "—" placeholder
   * address + lets us choose a rate), then enter checkout and assert we CANNOT reach the payment step —
   * the flow clamps us to the ADDRESS step until a REAL address is entered. (An API-only test would NOT
   * be stronger here because the API itself does not reject the placeholder.)
   */
  test('a placeholder estimator address can NEVER reach the payment step', async ({ page }) => {
    await addInStockVariantToCart(page);

    // Use the cart-page shipping ESTIMATOR — this sets the placeholder ("—") shipping address on the
    // cart and lets us pick a rate, satisfying the rate prerequisite but NOT the real-address one.
    // Navigate via the drawer (client-side nav keeps the in-memory cart — see fixtures).
    await gotoCartPageViaDrawer(page);
    await page.getByLabel(/postal code/i).fill('75001');
    await page.getByRole('button', { name: /^estimate$/i }).click();
    const chooseRate = page.getByRole('button', { name: /^choose$/i }).first();
    await expect(chooseRate).toBeVisible({ timeout: 15_000 });
    await chooseRate.click();
    await expect(page.getByRole('button', { name: /^chosen$/i }).first()).toBeVisible();

    // Now enter checkout via the cart page's Checkout link (client-side nav preserves the cart). Even
    // though a rate is chosen, the cart carries the placeholder address, so the flow must NOT land on
    // review/payment — it clamps to the EMAIL/ADDRESS step. Provide the email so the only remaining gate
    // is the (placeholder) address.
    await page.getByRole('link', { name: /^checkout$/i }).click();
    await expect(page.getByRole('heading', { name: /^checkout$/i })).toBeVisible();
    // If clamped to email, satisfy it; then we must be on the ADDRESS step, NOT review/payment.
    const emailField = page.getByLabel(/email address/i);
    if (await emailField.isVisible().catch(() => false)) {
      await emailField.fill('guest@example.com');
      await page.getByRole('button', { name: /^continue$/i }).click();
    }

    // The address step is shown (its shipping-address legend / country select), and crucially the
    // payment step is NOT current and the review/payment surfaces are absent — the placeholder cannot
    // advance past address.
    await expect(page.getByText(/shipping address/i).first()).toBeVisible();
    await expect(page.getByTestId('checkout-review')).toHaveCount(0);
    await expect(page.getByTestId('checkout-payment')).toHaveCount(0);
    await expect(page.getByTestId('proceed-to-payment')).toHaveCount(0);

    // Entering a REAL address now lets the flow advance past it (proving it was the address, not some
    // other gate, that blocked payment). After a real address we land on the shipping step.
    await fillAddress(page);
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByRole('button', { name: /shipping/i })).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  /**
   * GATED live payment: the actual Stripe PaymentElement MOUNT + confirm
   * needs a real Stripe test SECRET in the API (to mint a clientSecret) which CI does NOT provide. This
   * test runs ONLY when `E2E_STRIPE_LIVE=1` is set (a runner that wired a `sk_test_...` into the API);
   * otherwise it SKIPS with an explicit, logged reason. When enabled it drives the full flow and asserts
   * the `<PaymentElement>` Stripe iframe actually mounts inside the payment step.
   */
  test('live PaymentElement mounts (gated on E2E_STRIPE_LIVE)', async ({ page }) => {
    test.skip(
      process.env.E2E_STRIPE_LIVE !== '1',
      'E2E_STRIPE_LIVE not set — live PaymentElement mount/confirm requires a Stripe test SECRET in the API (CI has none). Default run asserts the payment step is REACHED, not the live mount.',
    );

    await addInStockVariantToCart(page);
    await gotoCheckoutViaDrawer(page);
    await page.getByLabel(/email address/i).fill('guest@example.com');
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByRole('button', { name: /address/i })).toHaveAttribute(
      'aria-current',
      'step',
    );
    await fillAddress(page);
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByRole('button', { name: /shipping/i })).toHaveAttribute(
      'aria-current',
      'step',
    );
    const rate = page.getByRole('radio').first();
    await expect(rate).toBeVisible({ timeout: 15_000 });
    await rate.click();
    const cont = page.getByRole('button', { name: /^continue$/i });
    await expect(cont).toBeEnabled({ timeout: 15_000 });
    await cont.click();
    await page.getByTestId('proceed-to-payment').click();

    // The payment step container mounts and Stripe injects its PaymentElement iframe.
    await expect(page.getByTestId('checkout-payment')).toBeVisible({ timeout: 20_000 });
    await expect(
      page.frameLocator('iframe[name^="__privateStripeFrame"]').first().locator('body'),
    ).toBeVisible({
      timeout: 20_000,
    });
  });
});

/** Fill the REAL shipping-address fields on the checkout address step. */
async function fillAddress(page: import('@playwright/test').Page): Promise<void> {
  await page.getByLabel(/full name/i).fill(REAL_ADDRESS.name);
  await page.getByLabel(/address line 1/i).fill(REAL_ADDRESS.line1);
  await page.getByLabel(/^city$/i).fill(REAL_ADDRESS.city);
  await page.getByLabel(/postal code/i).fill(REAL_ADDRESS.postalCode);
  // The country control is a <select> labelled "Country".
  await page.getByLabel(/^country$/i).selectOption(REAL_ADDRESS.country);
}
