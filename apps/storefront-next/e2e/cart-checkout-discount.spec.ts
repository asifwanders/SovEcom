/**
 * Storefront checkout with a discount code applied. The browser-level acceptance gate for the
 * storefront DISCOUNT path: a real shopper adds the seeded tee, lands on the cart page, applies
 * a discount code, and SEES the total drop (MONEY-CRITICAL — the figure is the server's
 * authoritative `cart.totals.grandTotal`; the UI does no discount math).
 *
 * The discount UI lives on the CART PAGE (the `cart-discount` section → `<DiscountForm>` →
 * `useCart().applyDiscount`, which POSTs `/store/v1/carts/:id/discounts`). On success the server
 * recomputes totals: the `<CartTotals variant="full">` summary then renders a `−€…` `discount` row and a
 * reduced `grand-total`. We assert BOTH: the new discount line appears AND the grand total strictly
 * decreased. The "remove" path is also exercised (it restores the original total) for symmetry.
 *
 * DETERMINISM: the discount (`E2E_DISCOUNT_CODE`, 10%) is provisioned idempotently via the admin API in
 * `beforeAll` (`ensureCartDiscount` — create-if-missing, tolerate 409), so the spec is re-runnable with
 * no reseed and never depends on a random promo. Fixture-guarded like cart-checkout.spec.ts: it
 * `test.skip`s cleanly when the catalog fixture is absent OR the discount can't be provisioned (an API
 * the runner didn't seed), so it never FAILS on an unprovisioned environment — it activates fully the
 * moment the stack is the seeded E2E stack the CI `storefront-e2e` job stands up.
 *
 * DEFAULT-THEME only (3.9f), matching cart-checkout.spec.ts: this drives the DRAWER cart affordance
 * (`gotoCartPageViaDrawer`); the boutique theme's page-link cart is a tracked follow-up.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  E2E_PRODUCT_TITLE,
  E2E_DISCOUNT_CODE,
  hasFixture,
  ensureCartDiscount,
  addInStockVariantToCart,
  gotoCartPageViaDrawer,
} from './fixtures';

/** The theme this run was booted with (mirrors cart-checkout.spec.ts; the drawer flow is default-only). */
const THEME = process.env.THEME === 'boutique' ? 'boutique' : 'default';

/**
 * Parse a formatted EUR price ("€17,99" / "−€2,00" / "17.99 €") into integer minor units. We only need a
 * RELATIVE comparison (did the total go down?), so a tolerant parse of the digit groups suffices: strip
 * every non-digit, read the result as cents. The currency uses 2 fraction digits in both locales, so the
 * trailing two digits are always the cents — robust to the symbol position, the thousands separator, and
 * the `,`/`.` decimal mark. Throws on a string with no digits (an empty/garbled total is a real defect).
 */
function priceToMinor(text: string): number {
  // Strips the sign too ("−€2,00" → 200) — intentional: callers only need the MAGNITUDE (a discount
  // row's amount, or a grand total), and compare magnitudes; the discount line's sign is fixed by the UI.
  const digits = text.replace(/\D/g, '');
  if (digits === '') throw new Error(`unparseable price: ${JSON.stringify(text)}`);
  return Number.parseInt(digits, 10);
}

/** Read the cart-page summary grand total as integer minor units (the authoritative `grandTotal`). */
async function grandTotalMinor(page: Page): Promise<number> {
  const text = await page.getByTestId('grand-total').innerText();
  return priceToMinor(text);
}

test.describe('cart discount → total decreases', () => {
  test.skip(
    THEME !== 'default',
    'drawer-affordance flow; boutique page-link cart covered in follow-up',
  );

  // Provision the deterministic discount once for the file (idempotent). If the API can't be reached /
  // provisioned, mark it absent so every test `test.skip`s (never fails on an unprovisioned env).
  let discountReady = false;
  test.beforeAll(async () => {
    discountReady = await ensureCartDiscount();
  });

  test.beforeEach(async ({ page }) => {
    const present = await hasFixture(page);
    test.skip(
      !present,
      'E2E catalog fixture not seeded (set SEED_E2E_FIXTURE=1) — flow not exercised.',
    );
    test.skip(
      !discountReady,
      'discount fixture not provisionable (admin API unreachable) — flow not exercised.',
    );
  });

  test('applying a discount code on the cart page reduces the grand total and shows a discount line', async ({
    page,
  }) => {
    await addInStockVariantToCart(page);
    await gotoCartPageViaDrawer(page);

    // Sanity: the seeded tee line is present (snapshotted NAME, never a UUID) before we touch discounts.
    await expect(page.getByTestId('line-title').first()).toHaveText(E2E_PRODUCT_TITLE);

    // No discount yet: the discount row is absent (only rendered when discountTotal > 0). Capture the
    // authoritative pre-discount grand total.
    await expect(page.getByTestId('discount')).toHaveCount(0);
    const before = await grandTotalMinor(page);
    expect(before).toBeGreaterThan(0);

    // Apply the deterministic code via the cart-page DiscountForm. The apply is an ASYNC server mutation
    // (POST /discounts → the context adopts the recomputed cart); the form then flips to its "applied"
    // state (`discount-applied`), which is our signal the server confirmed it (the cart is unchanged on a
    // 422, so this state ONLY appears on success).
    await page.getByLabel(/discount code/i).fill(E2E_DISCOUNT_CODE);
    await page.getByRole('button', { name: /^apply$/i }).click();
    await expect(page.getByTestId('discount-applied')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('discount-applied')).toContainText(E2E_DISCOUNT_CODE);

    // The server-recomputed totals now show a discount line (a `−€…` reduction) AND a STRICTLY lower
    // grand total. Both are read from the authoritative `<CartTotals>` summary — the UI did no math.
    const discountRow = page.getByTestId('discount');
    await expect(discountRow).toBeVisible();
    await expect(discountRow).toContainText(/€|EUR/);
    expect(priceToMinor(await discountRow.innerText())).toBeGreaterThan(0);

    // Poll the grand total until it reflects the reduction (the summary re-renders from the adopted cart).
    await expect(async () => {
      expect(await grandTotalMinor(page)).toBeLessThan(before);
    }).toPass({ timeout: 15_000 });

    // The reduction equals the discount line (no client arithmetic drift): before − discount === after.
    const after = await grandTotalMinor(page);
    const discountMinor = priceToMinor(await discountRow.innerText());
    expect(before - discountMinor).toBe(after);
  });

  test('removing the applied discount restores the original total', async ({ page }) => {
    await addInStockVariantToCart(page);
    await gotoCartPageViaDrawer(page);

    const before = await grandTotalMinor(page);

    // Apply, then confirm the reduction landed.
    await page.getByLabel(/discount code/i).fill(E2E_DISCOUNT_CODE);
    await page.getByRole('button', { name: /^apply$/i }).click();
    await expect(page.getByTestId('discount-applied')).toBeVisible({ timeout: 15_000 });
    await expect(async () => {
      expect(await grandTotalMinor(page)).toBeLessThan(before);
    }).toPass({ timeout: 15_000 });

    // Remove it → the form returns to its entry state, the discount row disappears, and the grand total
    // returns to the original (the server recomputes back to the undiscounted figure).
    await page.getByRole('button', { name: /^remove$/i }).click();
    await expect(page.getByTestId('discount-applied')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('discount')).toHaveCount(0);
    await expect(async () => {
      expect(await grandTotalMinor(page)).toBe(before);
    }).toPass({ timeout: 15_000 });
  });
});
