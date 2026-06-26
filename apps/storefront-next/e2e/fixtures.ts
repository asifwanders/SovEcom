/**
 * the deterministic E2E catalog fixture identity + the cart/
 * checkout interaction helpers the transactional specs share.
 *
 * The constants MIRROR the API seed (`apps/api/src/database/seeds/e2e/seed-e2e-fixture.ts`), which the
 * CI `storefront-e2e` job runs with `SEED_E2E_FIXTURE=1`. The cart/checkout specs are GUARDED on the
 * fixture's presence (`hasFixture`) so they `test.skip` cleanly if the catalog is empty (a local run
 * that forgot the flag) — they never FAIL on an empty catalog, mirroring the 3.7 empty-catalog posture.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, request as playwrightRequest, type Page } from '@playwright/test';
import { localePath, type Locale } from './helpers';

/**
 * The API origin the spec's `beforeAll` provisioning hits directly (admin login + discount create).
 * Mirrors the storefront's own default (`lib/browser-client.ts` DEFAULT_API_BASE_URL) and honours the
 * same `NEXT_PUBLIC_API_BASE_URL` override, so a non-default API host is respected.
 */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

/** The seeded product slug (PDP route `/{locale}/product/<slug>`). */
export const E2E_PRODUCT_SLUG = 'e2e-tee';
/** The seeded product title — the cart line / review name must render THIS, never a UUID. */
export const E2E_PRODUCT_TITLE = 'E2E Test Tee';
/** The in-stock variant's option axis value (the PDP `<select>` exposes "Size" with "M"/"XL"). */
export const E2E_IN_STOCK_OPTION = { axis: 'Size', value: 'M' };
/** The sold-out variant's option axis value — selecting it disables add-to-cart. */
export const E2E_OUT_OF_STOCK_OPTION = { axis: 'Size', value: 'XL' };

/* ── Customer-account fixture identity ────────────────────────────────────────
 * MIRRORS the API seed (`apps/api/src/database/seeds/e2e/seed-e2e-fixture.ts` —
 * E2E_ACCOUNT_EMAIL / E2E_ACCOUNT_PASSWORD / E2E_ACCOUNT_ORDER_NUMBER), seeded under SEED_E2E_FIXTURE=1.
 * The account specs log in with these and assert on the seeded delivered order + receipt invoice. */
/** The loginable seed customer's email. */
export const E2E_ACCOUNT_EMAIL = 'e2e-account@test.local';
/** The loginable seed customer's plaintext password (hashed Argon2id server-side at seed time). */
export const E2E_ACCOUNT_PASSWORD = 'E2e-Account-2026';
/** The seeded delivered order's human order number (orders.order_number). */
export const E2E_ACCOUNT_ORDER_NUMBER = 'E2E-ACCT-1001';

/* ── Discount fixture ──────────────────────────────────────────────────────────────────────────────
 * A deterministic, percentage discount the cart-checkout-discount spec applies to prove the storefront
 * discount flow visibly reduces the total. It is NOT part of the API seed fixture (which would force a
 * reseed/restart of the running stack): the spec PROVISIONS it idempotently via the admin API in its
 * own `beforeAll` (create-if-missing, tolerate the 409 on a re-run) — see `ensureCartDiscount` below.
 * `appliesTo: 'all'`, no min-cart / dates, `value: 1000` = 10% (percent ×100, per the discount engine),
 * so on the 1999-cent seeded tee it knocks 200 cents off (1999 → 1799). */
/** The deterministic cart discount code the spec applies (a stable, human code, never a UUID). */
export const E2E_DISCOUNT_CODE = 'E2E-CART-10PCT';
/** Its percentage value in the API's `value` units (percent ×100): 1000 = 10.00%. */
export const E2E_DISCOUNT_VALUE = 1000;
/** Admin (owner) principal that can create the discount via the admin API (mirrors the API seed). */
export const E2E_ADMIN_EMAIL = 'admin@default.local';
export const E2E_ADMIN_PASSWORD = 'E2e-Admin-2026';

/**
 * Pre-set the `cookie_consent` cookie on the browser context so the first-visit CookieBanner never
 * appears. This is more robust than clicking "Got it" — on the narrow mobile viewport the banner's own
 * descriptive paragraph overlaps the accept button and intercepts the click (a layout quirk that flakes
 * `dismissCookieBanner`). Setting the cookie up front is deterministic and viewport-independent. Call
 * BEFORE the first `page.goto`. (Mirrors `CookieBanner.CONSENT_COOKIE` = 'cookie_consent'.)
 */
export async function seedConsentCookie(page: Page): Promise<void> {
  await page.context().addCookies([
    {
      name: 'cookie_consent',
      value: 'dismissed',
      url: process.env.E2E_BASE_URL ?? 'http://localhost:3001',
    },
  ]);
}

/**
 * Whether the deterministic fixture product is present (the CI job seeds it; a local run might not).
 * Probed once via the storefront's PDP route: a 2xx means the product exists, a 404 means an empty
 * catalog → the caller `test.skip`s. Resilient: any non-OK status returns false.
 */
export async function hasFixture(page: Page, locale: Locale = 'en'): Promise<boolean> {
  const res = await page.request.get(localePath(locale, `product/${E2E_PRODUCT_SLUG}`));
  return res.ok();
}

/**
 * Navigate to the seeded PDP and add the IN-STOCK variant to the cart. Returns once the cart badge
 * reflects ≥1 item (the success path). Dismisses the cookie banner first (it overlays clickable chrome).
 *
 * The PDP variant block is a client island: for a multi-variant product it renders a "Size" <select>;
 * we choose "M" (in stock) so the add button enables, then click "Add to cart" and wait for the polite
 * "Added to cart" status + the header badge to update.
 */
export async function addInStockVariantToCart(page: Page, locale: Locale = 'en'): Promise<void> {
  await seedConsentCookie(page);
  await page.goto(localePath(locale, `product/${E2E_PRODUCT_SLUG}`));

  // Choose the in-stock size on the variant selector (the axis label is the accessible name).
  const sizeSelect = page.getByLabel(E2E_IN_STOCK_OPTION.axis, { exact: true });
  if (await sizeSelect.count()) {
    await sizeSelect.selectOption(E2E_IN_STOCK_OPTION.value);
  }

  const addButton = page.getByRole('button', { name: /add to cart/i });
  await expect(addButton).toBeEnabled();
  await addButton.click();

  // Polite success announcement (role="status"), then the header cart badge reflects the item.
  await expect(page.getByRole('status')).toContainText(/added to cart/i);
  await expect(cartBadge(page)).toBeVisible();
}

/** The header cart trigger — its accessible name embeds the count ("Cart, N items"). */
export function cartBadge(page: Page) {
  return page.getByRole('button', { name: /cart,/i });
}

/** Open the slide-out cart drawer from the header badge and wait for the dialog. */
export async function openCartDrawer(page: Page): Promise<void> {
  await cartBadge(page).click();
  await expect(page.getByRole('dialog', { name: /your cart/i })).toBeVisible();
}

/**
 * Navigate to the cart PAGE via the drawer's "View cart" link — a CLIENT-SIDE (next-intl `<Link>`)
 * navigation. This is REQUIRED (not `page.goto`): the cart id lives in the in-memory `CartProvider`
 * (the `sov_cart` cookie is httpOnly and there is no cart-id recovery endpoint), so a full
 * document load (`page.goto`) drops the cart and the page renders empty. Client navigation
 * keeps the React context alive, exactly as a real shopper clicking through does.
 */
export async function gotoCartPageViaDrawer(page: Page): Promise<void> {
  await openCartDrawer(page);
  await page
    .getByRole('dialog', { name: /your cart/i })
    .getByRole('link', { name: /view cart/i })
    .click();
  await expect(page.getByRole('heading', { name: /shopping cart/i })).toBeVisible();
}

/**
 * Navigate to checkout via the drawer's "Checkout" link (client-side nav — see `gotoCartPageViaDrawer`).
 * The drawer's Checkout link does NOT auto-close the drawer (unlike "View cart"), so after the route
 * change the drawer + its backdrop stay mounted and intercept clicks on the checkout form. Press Escape
 * to close the drawer (its keydown handler calls `close()`) so the checkout form is interactable.
 */
export async function gotoCheckoutViaDrawer(page: Page): Promise<void> {
  await openCartDrawer(page);
  const dialog = page.getByRole('dialog', { name: /your cart/i });
  await dialog.getByRole('link', { name: /^checkout$/i }).click();
  await expect(page.getByRole('heading', { name: /^checkout$/i })).toBeVisible();
  // Close the lingering drawer (the Checkout link doesn't auto-close it) so its backdrop stops
  // intercepting pointer events on the checkout form. Click its "Close cart" button (the Escape
  // handler only fires when focus is inside the panel, which a route change can move away).
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole('button', { name: /close cart/i }).click();
    await expect(dialog).toBeHidden();
  }
}

/**
 * Idempotently ensure the deterministic cart discount (`E2E_DISCOUNT_CODE`) exists, via the ADMIN API.
 * Called from the discount spec's `beforeAll`.
 *
 * WHY here and not in the API seed: the running E2E stack is started + seeded ONCE by the orchestrator;
 * adding the discount to `seed-e2e-fixture.ts` would force a rebuild/reseed/restart of that live stack.
 * Provisioning it through the admin API instead is non-disruptive AND still CI-friendly — the create is
 * idempotent (a 409 "code already exists" on a re-run is treated as success), so the spec is re-runnable
 * with no reseed, exactly like the other 3.14 fixtures.
 *
 * Returns `true` once the code is guaranteed present (created or already existed), `false` if the API/
 * admin login is unreachable (the caller then `test.skip`s, mirroring the empty-catalog posture — the
 * spec never FAILS merely because the API isn't provisionable). Uses a throwaway `APIRequestContext`
 * (not `page.request`) so it carries no storefront cookies and is independent of any page.
 */
export async function ensureCartDiscount(): Promise<boolean> {
  const ctx = await playwrightRequest.newContext({ baseURL: API_BASE_URL });
  try {
    // 1. Admin login → bearer access token.
    const login = await ctx.post('/admin/v1/auth/login', {
      data: { email: E2E_ADMIN_EMAIL, password: E2E_ADMIN_PASSWORD },
    });
    if (!login.ok()) return false;
    const accessToken = (await login.json())?.accessToken as string | undefined;
    if (!accessToken) return false;
    const auth = { Authorization: `Bearer ${accessToken}` };

    // 2. Already present? The admin list returns a flat array of discounts.
    const list = await ctx.get('/admin/v1/discounts', { headers: auth });
    if (list.ok()) {
      const existing = (await list.json()) as Array<{ code?: string | null }>;
      if (Array.isArray(existing) && existing.some((d) => d.code === E2E_DISCOUNT_CODE)) {
        return true;
      }
    }

    // 3. Create it. `value: 1000` = 10% (percent ×100); `appliesTo: 'all'`, active, no min/dates so it
    //    applies to the seeded tee cart unconditionally. A 409 (created by a prior run / concurrent
    //    worker) is success — the code is present either way.
    const create = await ctx.post('/admin/v1/discounts', {
      headers: auth,
      data: {
        name: 'E2E Cart 10pct',
        code: E2E_DISCOUNT_CODE,
        type: 'percentage',
        value: E2E_DISCOUNT_VALUE,
        appliesTo: 'all',
        active: true,
      },
    });
    return create.ok() || create.status() === 409;
  } catch {
    return false;
  } finally {
    await ctx.dispose();
  }
}

/* ── Out-of-band paid order ───────────────────────────────────────────────
 * "register → place order → view order history": REGISTER and VIEW HISTORY run through
 * the real storefront UI, but PLACING the order through the browser is impossible on this stack: UI
 * checkout terminates at the Stripe PaymentElement, which is gated on a real Stripe SECRET (E2E_STRIPE_
 * LIVE) the stack does not have (the same blocker `cart-checkout.spec.ts`'s "live payment" test skips
 * on). And there is NO admin/API endpoint that mints an order for a customer out of band — orders are
 * created ONLY by the Stripe-gated checkout. So the order is seeded by a DIRECT DB INSERT that MIRRORS
 * the existing seeded-order fixture shape (`seed-e2e-fixture.ts` seedFulfillmentFixture / seedAccount
 * Fixture): a `paid` order + one line (the seeded in-stock tee variant, resolved by SKU) + a `null →
 * paid` status-history row, all tied to the freshly-REGISTERED customer's id.
 *
 * WHY direct SQL (not the admin API): no order-create endpoint exists, and the order must bind to a
 * customer id that only comes into existence at UI-registration time — a DB insert is the only path
 * that deterministically ties the order to THAT customer. It runs through the SAME `docker compose
 * exec psql` channel the rest of the E2E tooling uses (no new Node Postgres dep — none is resolvable
 * from the storefront workspace). Values are passed as psql `-v` variables and quoted server-side
 * (`:'var'`), so the customer email / order number can never break out of the literal (no injection).
 *
 * Idempotent + re-runnable: the order_number is unique-per-run (caller passes a fresh one), and the
 * whole block is existence-guarded on (tenant, order_number) so a repeat insert is a clean no-op.
 * Single-tenant v1: the tenant id is resolved in-SQL (the sole `tenants` row), never hardcoded.
 */

/** Money for the seeded paid order (integer minor units, EUR) — mirrors the fixture order totals. */
export const E2E_OOB_ORDER_SUBTOTAL = 1999;
export const E2E_OOB_ORDER_SHIPPING = 490;
export const E2E_OOB_ORDER_TAX = 400;
export const E2E_OOB_ORDER_TOTAL =
  E2E_OOB_ORDER_SUBTOTAL + E2E_OOB_ORDER_SHIPPING + E2E_OOB_ORDER_TAX; // 2889

/** The in-stock seeded variant SKU the order line references (resolved to its real id in-SQL). */
const E2E_OOB_VARIANT_SKU = 'E2E-TEE-M';
/**
 * The compose file the docker FALLBACK targets for Postgres access. ABSOLUTE-resolved from the repo
 * root (this file lives at `apps/storefront-next/e2e/` → 3 levels up) so `docker compose -f` works
 * regardless of the test runner's cwd (Playwright runs with cwd = the storefront workspace, where a
 * bare `docker-compose.dev.yml` would not resolve). Overridable via `E2E_COMPOSE_FILE`.
 */
const COMPOSE_FILE =
  process.env.E2E_COMPOSE_FILE ?? resolve(__dirname, '..', '..', '..', 'docker-compose.dev.yml');
const PG_USER = process.env.E2E_PG_USER ?? 'sovecom';
/** Local dev fallback DB name when `DATABASE_URL` is unset (the docker compose dev database). */
const DEFAULT_DEV_DB = 'sovecom_dev';

/** Whether the `psql` client binary is on PATH (true on the ubuntu-latest CI runners; false on local macOS). */
function hasPsqlBinary(): boolean {
  const probe = spawnSync('psql', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * The Postgres database NAME, derived from `DATABASE_URL` when present (CI sets it to `sovecom_test`),
 * else the local dev default. Used by the docker fallback's `-d`. We parse only the db name (the host/
 * port/creds inside the container are fixed to the compose service); the `psql "$DATABASE_URL"` path
 * uses the URL verbatim, so this is purely for the fallback's `-d`.
 */
function databaseName(): string {
  const url = process.env.DATABASE_URL;
  if (!url) return DEFAULT_DEV_DB;
  try {
    // pathname is `/<dbname>` — strip the leading slash.
    return new URL(url).pathname.replace(/^\//, '') || DEFAULT_DEV_DB;
  } catch {
    return DEFAULT_DEV_DB;
  }
}

/**
 * The idempotent insert. A single `psql` statement that:
 *   - resolves the sole tenant + the registered customer (by active email) + the in-stock variant;
 *   - inserts a `paid` order bound to that customer (existence-guarded on order_number — NOT EXISTS);
 *   - inserts its one line item (the tee) and the `null → paid` status-history row.
 * `ON CONFLICT DO NOTHING`-style guarding is done via `WHERE NOT EXISTS` so a re-run is a no-op. The
 * customer MUST exist (registration ran first) — `customer_id` resolves via a scalar subquery; if the
 * customer is missing the order insert affects 0 rows and the caller's later UI assertion fails loudly
 * (a real signal), never silently mis-binds.
 */
const SEED_ORDER_SQL = `
WITH t AS (SELECT id AS tenant_id FROM tenants ORDER BY created_at LIMIT 1),
c AS (
  SELECT id AS customer_id FROM customers, t
  WHERE customers.tenant_id = t.tenant_id AND email = :'email'
    AND deleted_at IS NULL AND anonymized_at IS NULL
  LIMIT 1
),
v AS (
  SELECT id AS variant_id FROM product_variants, t
  WHERE product_variants.tenant_id = t.tenant_id AND sku = :'sku'
  LIMIT 1
),
ins_order AS (
  INSERT INTO orders (
    id, tenant_id, order_number, customer_id, email, status, currency,
    subtotal_amount, discount_amount, shipping_amount, tax_amount, total_amount, refunded_amount,
    is_b2b, reverse_charge, tax_inclusive, shipping_address, billing_address, shipping_method,
    fulfillment_frozen, metadata, placed_at, created_at, updated_at
  )
  SELECT
    gen_random_uuid(), t.tenant_id, :'orderNumber', c.customer_id, :'email', 'paid', 'EUR',
    ${E2E_OOB_ORDER_SUBTOTAL}, 0, ${E2E_OOB_ORDER_SHIPPING}, ${E2E_OOB_ORDER_TAX}, ${E2E_OOB_ORDER_TOTAL}, 0,
    false, false, false,
    '{"name":"E2E Buyer","company":null,"line1":"10 Rue de Rivoli","line2":null,"city":"Paris","postalCode":"75001","region":null,"country":"FR","phone":null}'::jsonb,
    '{"name":"E2E Buyer","company":null,"line1":"10 Rue de Rivoli","line2":null,"city":"Paris","postalCode":"75001","region":null,"country":"FR","phone":null}'::jsonb,
    'Colissimo', false, '{}'::jsonb, now(), now(), now()
  FROM t, c
  WHERE NOT EXISTS (
    SELECT 1 FROM orders o, t WHERE o.tenant_id = t.tenant_id AND o.order_number = :'orderNumber'
  )
  RETURNING id, tenant_id
),
ins_item AS (
  INSERT INTO order_items (
    id, tenant_id, order_id, variant_id, product_title, variant_title, sku,
    quantity, unit_price_amount, tax_rate, tax_amount, line_total_amount, refunded_quantity, created_at
  )
  SELECT gen_random_uuid(), ins_order.tenant_id, ins_order.id, v.variant_id,
    'E2E Test Tee', 'Medium', :'sku',
    1, 1999, 0.2000, 400, 2399, 0, now()
  FROM ins_order, v
  RETURNING order_id
)
INSERT INTO order_status_history (id, tenant_id, order_id, from_status, to_status, changed_by, note, created_at)
SELECT gen_random_uuid(), ins_order.tenant_id, ins_order.id, NULL, 'paid', NULL,
  'E2E scenario 13: seeded paid order out-of-band (UI checkout is Stripe-gated)', now()
FROM ins_order;
`;

/**
 * Seed a `paid` order for the just-registered customer (by email) with a unique order number. Throws
 * on a psql failure so the test reports the real cause rather than a downstream "order not visible".
 * Synchronous (execFileSync): the insert is a fast local round-trip and the caller awaits nothing else.
 *
 * Works in BOTH environments (mirrors `scripts/benchmarks/bench.sh`'s psql-or-docker fallback):
 *   - CI (`storefront-e2e`): Postgres is a GitHub Actions SERVICE container (NOT a compose project) and
 *     the runner has the `psql` client on PATH → `psql "$DATABASE_URL" …` (DB = `sovecom_test`, from the
 *     URL). A `docker compose exec` would fail there (no compose project).
 *   - Local macOS: no `psql` binary → fall back to `docker compose -f … exec -T postgres psql -U … -d
 *     <db-from-DATABASE_URL-or-dev-default>`.
 *
 * The SQL is fed on STDIN (not `-c`): psql performs `:'var'` interpolation only on script/stdin input,
 * not on a `-c` command string, so stdin is what makes the quoted-literal substitution actually fire.
 * email / orderNumber / sku all pass as `-v` quoted-literal variables (injection-safe) — no JS template
 * interpolation leaks into the SQL.
 */
export function seedPaidOrderForCustomer(email: string, orderNumber: string): void {
  const vars = [
    '-v',
    'ON_ERROR_STOP=1',
    '-v',
    `email=${email}`,
    '-v',
    `orderNumber=${orderNumber}`,
    '-v',
    `sku=${E2E_OOB_VARIANT_SKU}`,
  ];

  if (hasPsqlBinary() && process.env.DATABASE_URL) {
    // CI / any host with the psql client: connect via the URL verbatim.
    execFileSync('psql', [process.env.DATABASE_URL, ...vars], {
      input: SEED_ORDER_SQL,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return;
  }

  // Local fallback: pipe through the compose Postgres container's psql.
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      COMPOSE_FILE,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      PG_USER,
      '-d',
      databaseName(),
      ...vars,
    ],
    { input: SEED_ORDER_SQL, stdio: ['pipe', 'pipe', 'pipe'] },
  );
}
