/**
 * DETERMINISTIC storefront-E2E catalog fixture.
 *
 * WHAT: a single PUBLISHED product (`slug='e2e-tee'`) with TWO variants —
 *   - `E2E-TEE-M`  — in stock (stock_quantity=50, no backorder) → the happy-path add-to-cart variant;
 *   - `E2E-TEE-OOS` — sold out (stock_quantity=0, no backorder) → exercises the out-of-stock / disabled
 *     add-to-cart affordance.
 * Both are EUR (matches the seeded FR Colissimo rate + EU VAT), known slug + price so the Playwright
 * cart/checkout specs can navigate deterministically (PDP → add → cart → checkout) without scraping a
 * random slug. The shipping rate + tax config are NOT created here — they come from the baseline seed
 * (`seed.ts` 4a/4b) which this runs alongside; this module ONLY adds the catalog the empty-catalog
 * baseline omits.
 *
 * WHY guarded, not always-on: the install seed must stay catalog-EMPTY for a real install (a demo
 * product in production would be wrong) AND the existing 3.7 E2E specs are written to be resilient to an
 * empty catalog. So this is OPT-IN via `SEED_E2E_FIXTURE=1` (set only in the CI `storefront-e2e` job and
 * by a local E2E runner). With the fixture present the empty-catalog-resilient specs STILL pass (they
 * assert only always-present chrome / static routes unconditionally), and the previously-skipped
 * Product/Offer JSON-LD path activates automatically (a bonus, not a regression).
 *
 * IDEMPOTENT: products use `ON CONFLICT (tenant_id, slug) DO NOTHING`; variants `ON CONFLICT
 * (tenant_id, sku) DO NOTHING`. A re-run is a no-op and never errors/duplicates. Tenant-scoped (default
 * tenant). Uses the Drizzle insert API so the `id` uuidv7 `$defaultFn` applies; the variant→product FK
 * is resolved by re-reading the product id when the product already existed.
 *
 * NON-BLOCKING contract mirrors `seedDefaultPages`: this function does NOT swallow its own errors (so a
 * test can assert on them); the install seed wraps the call in try/catch (log + continue) so a fixture
 * failure can never abort the baseline seed.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import * as argon2 from 'argon2';
import { products } from '../../schema/products';
import { productVariants } from '../../schema/product_variants';
import { customers } from '../../schema/customers';
import { customerAddresses } from '../../schema/customer_addresses';
import { orders } from '../../schema/orders';
import { orderItems } from '../../schema/order_items';
import { orderStatusHistory } from '../../schema/order_status_history';
import { invoices } from '../../schema/invoices';

/** Minimal db surface this seeder needs — satisfied by the app + harness Drizzle db. */
type SeedDb = Pick<PostgresJsDatabase<Record<string, unknown>>, 'insert' | 'execute'>;

/** The fixture identity the Playwright specs target (kept in sync with `e2e/fixtures.ts`). */
export const E2E_PRODUCT_SLUG = 'e2e-tee';
export const E2E_PRODUCT_TITLE = 'E2E Test Tee';
/** In-stock variant — the happy-path add-to-cart target. */
export const E2E_VARIANT_IN_STOCK = {
  sku: 'E2E-TEE-M',
  title: 'Medium',
  options: { Size: 'M' } as Record<string, string>,
  priceAmount: 1999,
  currency: 'EUR',
  stockQuantity: 50,
};
/** Sold-out variant — exercises the out-of-stock disabled add-to-cart affordance. */
export const E2E_VARIANT_OUT_OF_STOCK = {
  sku: 'E2E-TEE-OOS',
  title: 'Sold Out',
  options: { Size: 'XL' } as Record<string, string>,
  priceAmount: 1999,
  currency: 'EUR',
  stockQuantity: 0,
};

/* ───────────────────────── Customer-account fixture ───────────────────────── */

/**
 * A deterministic, loginable customer + one delivered order + its receipt-invoice, seeded alongside
 * the catalog fixture so the 3.8b account-area Playwright specs (login, orders list/detail, invoice
 * download, address book, return request, profile edit, RGPD export) run against a known, stable
 * principal. The identities are MIRRORED in `apps/storefront-next/e2e/fixtures.ts` (kept in sync the
 * way `E2E_PRODUCT_SLUG` is). All inserts are idempotent (existence-guarded / ON CONFLICT DO NOTHING)
 * and the whole block is non-fatal (the install seed wraps `seedE2eFixture` in try/catch).
 */
export const E2E_ACCOUNT_EMAIL = 'e2e-account@test.local';
/** The plaintext password the specs log in with; hashed (Argon2id) at seed time. */
export const E2E_ACCOUNT_PASSWORD = 'E2e-Account-2026';

/**
 * Admin (owner) principal for the admin-SPA E2E (mirrored in apps/admin/e2e/fixtures.ts).
 * The baseline seed creates `admin@default.local` with a NON-usable placeholder hash (set
 * via the setup-token flow) and leaves `installed=false`. For E2E we give that admin a REAL Argon2id
 * password and flip `installed=true` so the admin app is usable without driving the setup wizard.
 * Gated by SEED_E2E_FIXTURE — NEVER runs on a real install.
 */
export const E2E_ADMIN_EMAIL = 'admin@default.local';
export const E2E_ADMIN_PASSWORD = 'E2e-Admin-2026';
export const E2E_ACCOUNT_NAME = 'E2E Account';

/**
 * The Argon2id-shaped placeholder the baseline seed (`seed.ts`) writes for the admin shell — a
 * sentinel no password verifies against. KEPT IN SYNC with `seed.ts` (which imports this
 * single source of truth). The fail-safe admin mutation in `seedAccountFixture` only overwrites the
 * admin credential when the stored hash STILL equals this sentinel (i.e. nobody has set a real one).
 */
export const PLACEHOLDER_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$c2VlZHNhbHQ$bm90LWEtcmVhbC1oYXNo';
/** The hardcoded human order number the specs assert on (orders.order_number MAY gap). */
export const E2E_ACCOUNT_ORDER_NUMBER = 'E2E-ACCT-1001';

/**
 * Admin-fulfilment fixture (view order → fulfil → ship). A POOL of
 * deterministic `paid` orders the admin-SPA E2E (`order-fulfil.spec.ts`) drives through
 * `paid → fulfilled → shipped`. A POOL (not one order) so the spec is RE-RUNNABLE without a reseed:
 * each run consumes the first still-`paid` order (the prior run's order is now `shipped` and filtered
 * out by the list's status facet), so every run exercises the real fulfil + ship buttons end-to-end.
 *
 * Each order is seeded in `paid` (the only non-frozen status from which the order-detail UI surfaces
 * BOTH "Mark fulfilled" then "Mark shipped"), with a matching `null → paid` `order_status_history` row
 * (so the Timeline renders) and one order line. NO payment row is needed — the admin transition
 * endpoint only checks the state-machine edge + `fulfillment_frozen` (false here), never a payment.
 * Idempotent (SELECT-guarded on order_number); gated by SEED_E2E_FIXTURE — never on a real install.
 */
export const E2E_FULFILL_ORDER_NUMBERS = ['E2E-FULFIL-1001', 'E2E-FULFIL-1002', 'E2E-FULFIL-1003'];
/** Stable prefix the spec uses to recognise a fixture fulfilment order in the list. */
export const E2E_FULFILL_ORDER_PREFIX = 'E2E-FULFIL-';
/**
 * The seeded receipt's series + number. The number is deterministic and high enough that it will not
 * collide with the gapless `invoice_counters` (a fresh seed issues no invoices, so the counter is at
 * its default and real issuance starts at 2026-000001 — this fixture sits well above any test run).
 */
const E2E_ACCOUNT_INVOICE_SERIES = 'STD';
const E2E_ACCOUNT_INVOICE_NUMBER = '2026-000010';

/** Order money (integer minor units, EUR). Rendered verbatim by the storefront — no client math. */
const E2E_ORDER_SUBTOTAL = 1999;
const E2E_ORDER_SHIPPING = 490;
const E2E_ORDER_TAX = 400; // 20% of the 1999 subtotal (399.8 → 400)
const E2E_ORDER_TOTAL = E2E_ORDER_SUBTOTAL + E2E_ORDER_SHIPPING + E2E_ORDER_TAX; // 2889

/** The order/invoice address snapshot (a plain JSONB blob — mirrors the order address shape). */
const E2E_ACCOUNT_ADDRESS = {
  name: E2E_ACCOUNT_NAME,
  company: null as string | null,
  line1: '10 Rue de Rivoli',
  line2: null as string | null,
  city: 'Paris',
  postalCode: '75001',
  region: null as string | null,
  country: 'FR',
  phone: null as string | null,
};

/**
 * Idempotently seed the deterministic E2E catalog fixture for `tenantId`. Returns the number of rows
 * (product + variants) actually inserted on this run (0 on a repeat run).
 */
export async function seedE2eFixture(db: SeedDb, tenantId: string): Promise<number> {
  // Defense-in-depth: this fixture overwrites the admin credential with a repo-public plaintext and
  // flips `installed=true`. The standalone `pnpm seed` script bypasses `env.validation.ts`, so this
  // is the ONLY production guard on that path. Abort LOUDLY (never silently skip) in production —
  // even when SEED_E2E_FIXTURE=1 is (mis)set there. Matches the project's NODE_ENV convention.
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'seedE2eFixture must never run in production (it writes a public test admin credential and flips installed=true). Refusing to seed.',
    );
  }

  let inserted = 0;

  // 1. The published product (idempotent on (tenant_id, slug)).
  const productRows = await db
    .insert(products)
    .values({
      tenantId,
      title: E2E_PRODUCT_TITLE,
      slug: E2E_PRODUCT_SLUG,
      description: 'A deterministic test product seeded for the storefront E2E checkout flow.',
      status: 'published',
    })
    .onConflictDoNothing({ target: [products.tenantId, products.slug] })
    .returning({ id: products.id });
  inserted += productRows.length;

  // Resolve the product id — re-read it when the product already existed (idempotent re-run).
  let productId = productRows[0]?.id;
  if (!productId) {
    const existing = (await db.execute(
      sql`select id from products where tenant_id = ${tenantId} and slug = ${E2E_PRODUCT_SLUG} limit 1`,
    )) as unknown as Array<{ id: string }>;
    productId = existing[0]?.id;
    if (!productId) {
      throw new Error('E2E fixture: product missing after insert (slug=e2e-tee)');
    }
  }

  // 2. The two variants (idempotent on (tenant_id, sku)). position orders them on the PDP.
  for (const [position, v] of [E2E_VARIANT_IN_STOCK, E2E_VARIANT_OUT_OF_STOCK].entries()) {
    const variantRows = await db
      .insert(productVariants)
      .values({
        tenantId,
        productId,
        sku: v.sku,
        title: v.title,
        options: v.options,
        priceAmount: v.priceAmount,
        currency: v.currency,
        stockQuantity: v.stockQuantity,
        allowBackorder: false,
        position,
      })
      .onConflictDoNothing({ target: [productVariants.tenantId, productVariants.sku] })
      .returning({ id: productVariants.id });
    inserted += variantRows.length;
  }

  // 3. The customer-account fixture (customer + address + delivered order + items + receipt invoice).
  //    The variants above are seeded first, so the account order item can resolve the in-stock
  //    variant's REAL (uuidv7, non-deterministic) id by SKU inside seedAccountFixture.
  inserted += await seedAccountFixture(db, tenantId);

  // 4. The admin-fulfilment fixture (a pool of `paid` orders for the order fulfil→ship E2E). Seeded
  //    after the catalog so each order line can resolve the in-stock variant's REAL id by SKU.
  inserted += await seedFulfillmentFixture(db, tenantId);

  return inserted;
}

/** Read one id by an arbitrary equality `where` clause, or undefined when absent. */
async function selectId(db: SeedDb, query: ReturnType<typeof sql>): Promise<string | undefined> {
  const rows = (await db.execute(query)) as unknown as Array<{ id: string }>;
  return rows[0]?.id;
}

/**
 * Idempotently seed a POOL of `paid` orders for the admin fulfil→ship E2E (scenario 11). Each is a
 * stand-alone `paid` order with a `null → paid` status-history row + one order line. Returns the rows
 * inserted on this run (0 on a repeat). A re-run is a clean no-op (existence-guard on order_number).
 *
 * A POOL (not a single order) makes the spec deterministic across re-runs WITHOUT a reseed: the spec
 * picks the first order still in `paid`, drives it to `shipped`, and the next run picks the next one.
 * Three covers the "run the spec twice consecutively" validation with headroom; if the pool is ever
 * exhausted the spec fails loudly (a real signal to reseed) rather than silently no-op'ing.
 */
async function seedFulfillmentFixture(db: SeedDb, tenantId: string): Promise<number> {
  let inserted = 0;

  // The order line's variant id (real uuidv7) is resolved by SKU from the catalog fixture above. It
  // always exists here (step 2 ran first); a missing row is a contract break → fail loudly.
  const variantId = await selectId(
    db,
    sql`select id from product_variants where tenant_id = ${tenantId} and sku = ${E2E_VARIANT_IN_STOCK.sku} limit 1`,
  );
  if (!variantId) {
    throw new Error(
      `E2E fulfilment fixture: in-stock variant (sku=${E2E_VARIANT_IN_STOCK.sku}) missing — catalog fixture must seed first`,
    );
  }

  // A distinct placed-at per order (1 minute apart) so the newest-first list order is stable.
  const basePlacedAt = new Date('2026-02-01T09:00:00.000Z').getTime();

  for (const [i, orderNumber] of E2E_FULFILL_ORDER_NUMBERS.entries()) {
    // SELECT-guard on (tenant, order_number) — uniform with the account fixture; a re-run is a no-op.
    const existing = await selectId(
      db,
      sql`select id from orders where tenant_id = ${tenantId} and order_number = ${orderNumber} limit 1`,
    );
    if (existing) continue;

    const placedAt = new Date(basePlacedAt + i * 60_000);
    const orderRows = await db
      .insert(orders)
      .values({
        tenantId,
        orderNumber,
        customerId: null,
        email: `e2e-fulfil-${i + 1}@test.local`,
        status: 'paid',
        currency: 'EUR',
        subtotalAmount: E2E_ORDER_SUBTOTAL,
        shippingAmount: E2E_ORDER_SHIPPING,
        taxAmount: E2E_ORDER_TAX,
        totalAmount: E2E_ORDER_TOTAL,
        taxInclusive: false,
        shippingAddress: E2E_ACCOUNT_ADDRESS,
        billingAddress: E2E_ACCOUNT_ADDRESS,
        shippingMethod: 'Colissimo',
        placedAt,
      })
      .returning({ id: orders.id });
    const orderId = orderRows[0]?.id;
    if (!orderId) {
      throw new Error(`E2E fulfilment fixture: order ${orderNumber} missing after insert`);
    }
    inserted += 1;

    // The order line (the in-stock seeded variant). line_total = unit×qty + itemised 20% tax.
    await db.insert(orderItems).values({
      tenantId,
      orderId,
      variantId,
      productTitle: E2E_PRODUCT_TITLE,
      variantTitle: E2E_VARIANT_IN_STOCK.title,
      sku: E2E_VARIANT_IN_STOCK.sku,
      quantity: 1,
      unitPriceAmount: 1999,
      taxRate: '0.2000',
      taxAmount: 400,
      lineTotalAmount: 2399,
      refundedQuantity: 0,
    });
    inserted += 1;

    // The initial `null → paid` history row so the order-detail Timeline renders a real entry.
    await db.insert(orderStatusHistory).values({
      tenantId,
      orderId,
      fromStatus: null,
      toStatus: 'paid',
      changedBy: null,
      note: 'E2E fixture: seeded paid',
      createdAt: placedAt,
    });
    inserted += 1;
  }

  return inserted;
}

/**
 * Idempotently seed the loginable account + its one delivered order + receipt invoice. Returns the
 * number of rows inserted on this run (0 on a repeat). Each step is existence-guarded so a partial
 * prior run (or a re-run) never duplicates or errors.
 *
 * The tenant's tax mode is `none` on a fresh seed → the issued document is a RECEIPT (documentKind
 * 'receipt', no VAT lines), mirroring `buildInvoiceContent('none', …)`. We build the immutable
 * `tax_breakdown` snapshot by hand here (the on-demand PDF renderer reads it directly), with
 * storage_key NULL so a download renders a real %PDF on demand from the snapshot.
 */
async function seedAccountFixture(db: SeedDb, tenantId: string): Promise<number> {
  let inserted = 0;

  // 3a. Customer — SELECT-guard (NOT ON CONFLICT). The customers active-email uniqueness is a PARTIAL
  //     unique index (`customers_tenant_email_active_uq ON (tenant_id, email) WHERE deleted_at IS NULL
  //     AND anonymized_at IS NULL`), which Postgres cannot infer from a bare column list — an
  //     `ON CONFLICT (tenant_id, email)` raises 42P10. So we look the active customer up first and
  //     insert only when absent (a re-run is then a clean no-op). A REAL Argon2id hash so the
  //     storefront login (PasswordService.verify) succeeds for E2E_ACCOUNT_PASSWORD.
  let customerId = await selectId(
    db,
    sql`select id from customers where tenant_id = ${tenantId} and email = ${E2E_ACCOUNT_EMAIL} and deleted_at is null and anonymized_at is null limit 1`,
  );
  if (!customerId) {
    const passwordHash = await argon2.hash(E2E_ACCOUNT_PASSWORD, { type: argon2.argon2id });
    const customerRows = await db
      .insert(customers)
      .values({
        tenantId,
        email: E2E_ACCOUNT_EMAIL,
        passwordHash,
        name: E2E_ACCOUNT_NAME,
      })
      .returning({ id: customers.id });
    customerId = customerRows[0]?.id;
    if (!customerId) {
      throw new Error('E2E account fixture: customer missing after insert');
    }
    inserted += 1;
  }

  // 3a-bis. Admin E2E principal: give the seeded owner a REAL password + mark the store
  //         installed, so the admin-SPA E2E can log in without the setup wizard.
  //
  //         FAIL-SAFE on a real install (finding #1): only clobber the admin credential + flip
  //         `installed` when the store is GENUINELY FRESH — `system_state.installed` is currently
  //         false AND the admin's stored hash is STILL the placeholder sentinel (nobody has
  //         completed the setup-token flow). If a real (non-placeholder) admin credential exists, we
  //         MUST NOT overwrite it (nor re-flip installed) — leave the store untouched. The
  //         NODE_ENV==='production' guard at the top of seedE2eFixture is the loud first line; this is
  //         the second, data-driven line that also protects a mistakenly-promoted dev/staging store.
  const installedRows = (await db.execute(
    sql`select value from system_state where key = 'installed' limit 1`,
  )) as unknown as Array<{ value: unknown }>;
  const isInstalled = installedRows[0]?.value === true || installedRows[0]?.value === 'true';

  const adminRows = (await db.execute(
    sql`select password_hash from users where tenant_id = ${tenantId} and email = ${E2E_ADMIN_EMAIL} limit 1`,
  )) as unknown as Array<{ password_hash: string }>;
  const adminHashStored = adminRows[0]?.password_hash;
  const adminIsPlaceholder = adminHashStored === PLACEHOLDER_PASSWORD_HASH;

  if (!isInstalled && adminIsPlaceholder) {
    const adminHash = await argon2.hash(E2E_ADMIN_PASSWORD, { type: argon2.argon2id });
    await db.execute(
      sql`update users set password_hash = ${adminHash} where tenant_id = ${tenantId} and email = ${E2E_ADMIN_EMAIL}`,
    );
    await db.execute(sql`update system_state set value = 'true'::jsonb where key = 'installed'`);
  }

  // 3b. Default shipping address (no natural unique key → existence-guard on customer+line1).
  const existingAddr = await selectId(
    db,
    sql`select id from customer_addresses where tenant_id = ${tenantId} and customer_id = ${customerId} and line1 = ${E2E_ACCOUNT_ADDRESS.line1} limit 1`,
  );
  if (!existingAddr) {
    await db.insert(customerAddresses).values({
      tenantId,
      customerId,
      type: 'shipping',
      isDefault: true,
      name: E2E_ACCOUNT_ADDRESS.name,
      line1: E2E_ACCOUNT_ADDRESS.line1,
      city: E2E_ACCOUNT_ADDRESS.city,
      postalCode: E2E_ACCOUNT_ADDRESS.postalCode,
      country: E2E_ACCOUNT_ADDRESS.country,
    });
    inserted += 1;
  }

  // 3c. The delivered order — SELECT-guard on (tenant, order_number) (uniform with the other rows;
  //     no ON CONFLICT). order_number is unique per tenant but a plain SELECT-guard is simplest.
  const placedAt = new Date('2026-01-15T10:00:00.000Z');
  let orderId = await selectId(
    db,
    sql`select id from orders where tenant_id = ${tenantId} and order_number = ${E2E_ACCOUNT_ORDER_NUMBER} limit 1`,
  );
  if (!orderId) {
    const orderRows = await db
      .insert(orders)
      .values({
        tenantId,
        orderNumber: E2E_ACCOUNT_ORDER_NUMBER,
        customerId,
        email: E2E_ACCOUNT_EMAIL,
        status: 'delivered',
        currency: 'EUR',
        subtotalAmount: E2E_ORDER_SUBTOTAL,
        shippingAmount: E2E_ORDER_SHIPPING,
        taxAmount: E2E_ORDER_TAX,
        totalAmount: E2E_ORDER_TOTAL,
        taxInclusive: false,
        shippingAddress: E2E_ACCOUNT_ADDRESS,
        billingAddress: E2E_ACCOUNT_ADDRESS,
        shippingMethod: 'Colissimo',
        placedAt,
      })
      .returning({ id: orders.id });
    orderId = orderRows[0]?.id;
    if (!orderId) {
      throw new Error('E2E account fixture: order missing after insert');
    }
    inserted += 1;
  }

  // 3d. One order line (the in-stock seeded variant). Existence-guard on (order, sku) — order_items
  //     has no natural unique key. line_total = unit×qty (1999), tax_amount itemised at 20%.
  //
  //     variant_id is the in-stock variant's REAL id, looked up by SKU. Variant ids are uuidv7
  //     (generated at insert, NON-deterministic), so it must be read back from the catalog fixture
  //     seeded earlier in this same run — never hardcoded/derived (a fabricated id violates the
  //     order_items_variant_fk composite FK). The variant always exists here (step 2 ran first); a
  //     missing row would be a contract break, so we fail loudly rather than insert a dangling FK.
  const existingItem = await selectId(
    db,
    sql`select id from order_items where tenant_id = ${tenantId} and order_id = ${orderId} and sku = ${E2E_VARIANT_IN_STOCK.sku} limit 1`,
  );
  if (!existingItem) {
    const variantId = await selectId(
      db,
      sql`select id from product_variants where tenant_id = ${tenantId} and sku = ${E2E_VARIANT_IN_STOCK.sku} limit 1`,
    );
    if (!variantId) {
      throw new Error(
        `E2E account fixture: in-stock variant (sku=${E2E_VARIANT_IN_STOCK.sku}) missing — catalog fixture must seed first`,
      );
    }
    await db.insert(orderItems).values({
      tenantId,
      orderId,
      variantId,
      productTitle: E2E_PRODUCT_TITLE,
      variantTitle: E2E_VARIANT_IN_STOCK.title,
      sku: E2E_VARIANT_IN_STOCK.sku,
      quantity: 1,
      unitPriceAmount: 1999,
      taxRate: '0.2000',
      taxAmount: 400,
      lineTotalAmount: 2399,
      refundedQuantity: 0,
    });
    inserted += 1;
  }

  // 3e. The receipt invoice (idempotent on (tenant, series, invoice_number)). A `none`-mode RECEIPT:
  //     documentKind 'receipt', no VAT lines, mirroring buildInvoiceContent('none', …). storage_key
  //     NULL → the download renders the PDF on demand from this snapshot.
  const sellerSnapshot = {
    name: 'Default Store',
    address: null,
    siren: null,
    vatNumber: null,
    country: null,
  };
  const buyerSnapshot = {
    name: E2E_ACCOUNT_NAME,
    email: E2E_ACCOUNT_EMAIL,
    address: E2E_ACCOUNT_ADDRESS,
    vatNumber: null,
    isB2b: false,
  };
  // The immutable rendered content snapshot (InvoiceContent shape the PDF renderer reads). Receipt:
  // net lines, no VAT, total == order total. The renderer typesets the snapshot verbatim.
  const taxBreakdown = {
    taxMode: 'none',
    documentKind: 'receipt',
    taxInclusive: false,
    currency: 'EUR',
    lines: [
      {
        description: `${E2E_PRODUCT_TITLE} — ${E2E_VARIANT_IN_STOCK.title}`,
        sku: E2E_VARIANT_IN_STOCK.sku,
        quantity: 1,
        unitPriceAmount: 1999,
        taxRate: 0,
        lineNetAmount: 1999,
        lineTaxAmount: 0,
      },
    ],
    subtotalAmount: E2E_ORDER_SUBTOTAL,
    discount: { netAmount: 0 },
    shipping: { netAmount: E2E_ORDER_SHIPPING, taxAmount: 0, taxRate: 0 },
    taxAmount: 0,
    totalAmount: E2E_ORDER_TOTAL,
    taxBreakdown: [] as unknown[],
    reverseCharge: false,
    viesConsultationRef: null,
    mentions: ['Prices shown are final; no VAT is applied under the current tax regime.'],
  };
  // SELECT-guard on (tenant, series, invoice_number) — uniform with the other rows; no ON CONFLICT.
  const existingInvoice = await selectId(
    db,
    sql`select id from invoices where tenant_id = ${tenantId} and series = ${E2E_ACCOUNT_INVOICE_SERIES} and invoice_number = ${E2E_ACCOUNT_INVOICE_NUMBER} limit 1`,
  );
  if (!existingInvoice) {
    await db.insert(invoices).values({
      tenantId,
      orderId,
      type: 'invoice',
      series: E2E_ACCOUNT_INVOICE_SERIES,
      invoiceNumber: E2E_ACCOUNT_INVOICE_NUMBER,
      issuedAt: placedAt,
      sellerSnapshot,
      buyerSnapshot,
      currency: 'EUR',
      subtotalAmount: E2E_ORDER_SUBTOTAL,
      taxBreakdown,
      taxAmount: 0,
      totalAmount: E2E_ORDER_TOTAL,
      reverseCharge: false,
      storageKey: null,
    });
    inserted += 1;
  }

  return inserted;
}
