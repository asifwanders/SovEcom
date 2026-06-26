/**
 * Integration tests for the deterministic storefront E2E catalog fixture seed
 * (`seedE2eFixture`).
 *
 * Real Postgres via the auth harness. Covers:
 *   - The published product + its two variants (in-stock + sold-out) are created with the EXACT slug /
 *     sku / price / currency / stock the Playwright specs depend on.
 *   - The product is retrievable via the SAME store path the storefront uses (`ProductsService
 *     .storeFindBySlug`) with `status='published'`, and its variants surface the right coarse
 *     `availability` (in-stock variant true, sold-out variant false) — the out-of-stock add-to-cart
 *     E2E path relies on this.
 *   - Idempotency: a second run inserts nothing and does not error/duplicate.
 *   - Tenant-scoped (rows carry the passed tenant only).
 */
import {
  bootAuthApp,
  teardownAuthApp,
  resetAuthState,
  makeTenant,
  AuthHarness,
  newId,
} from '../auth/_auth-harness';
import {
  seedE2eFixture,
  E2E_PRODUCT_SLUG,
  E2E_VARIANT_IN_STOCK,
  E2E_VARIANT_OUT_OF_STOCK,
  E2E_ACCOUNT_EMAIL,
  E2E_ACCOUNT_ORDER_NUMBER,
} from '../../../src/database/seeds/e2e/seed-e2e-fixture';
import { ProductsService } from '../../../src/catalog/products/products.service';

describe('Catalog — E2E catalog fixture seed (integration)', () => {
  let h: AuthHarness;

  beforeAll(async () => {
    h = await bootAuthApp();
  });
  afterAll(async () => {
    await teardownAuthApp(h);
  });
  beforeEach(async () => {
    await resetAuthState(h);
  });

  it('seeds the published product + both variants with the deterministic identity the specs target', async () => {
    const tenantId = await makeTenant(h);
    const count = await seedE2eFixture(h.db, tenantId);
    // Published product + 2 variants + the account fixture (customer/address/order/items/invoice)
    // + the 3.14 fulfillment paid-order pool (seedFulfillmentFixture, added in bafdd9b for
    // admin-E2E scenarios 8 & 11). Total rows inserted on a fresh tenant = 17.
    expect(count).toBe(17);

    const products = await h.client<{ slug: string; status: string }[]>`
      select slug, status from products where tenant_id = ${tenantId}
    `;
    expect(products).toHaveLength(1);
    expect(products[0]!.slug).toBe(E2E_PRODUCT_SLUG);
    expect(products[0]!.status).toBe('published');

    const variants = await h.client<
      { sku: string; price_amount: number; currency: string; stock_quantity: number }[]
    >`
      select sku, price_amount, currency, stock_quantity from product_variants where tenant_id = ${tenantId} order by position
    `;
    expect(variants).toHaveLength(2);
    const inStock = variants.find((v) => v.sku === E2E_VARIANT_IN_STOCK.sku)!;
    const oos = variants.find((v) => v.sku === E2E_VARIANT_OUT_OF_STOCK.sku)!;
    expect(inStock.price_amount).toBe(E2E_VARIANT_IN_STOCK.priceAmount);
    expect(inStock.currency).toBe('EUR');
    expect(inStock.stock_quantity).toBe(E2E_VARIANT_IN_STOCK.stockQuantity);
    expect(oos.stock_quantity).toBe(0);
  });

  it('is retrievable via the store path with correct coarse availability per variant', async () => {
    const tenantId = await makeTenant(h);
    await seedE2eFixture(h.db, tenantId);

    const svc = h.app.get(ProductsService, { strict: false });
    const dto = await svc.storeFindBySlug(tenantId, E2E_PRODUCT_SLUG);
    expect(dto.slug).toBe(E2E_PRODUCT_SLUG);
    expect(dto.status).toBe('published');
    expect(dto.variants).toHaveLength(2);

    const inStock = dto.variants.find((v) => v.title === E2E_VARIANT_IN_STOCK.title)!;
    const oos = dto.variants.find((v) => v.title === E2E_VARIANT_OUT_OF_STOCK.title)!;
    // The in-stock variant is purchasable; the sold-out one (stock 0, no backorder) is not.
    expect(inStock.availability).toBe(true);
    expect(oos.availability).toBe(false);
  });

  it('is idempotent — re-running inserts nothing and does not duplicate', async () => {
    const tenantId = await makeTenant(h);

    const first = await seedE2eFixture(h.db, tenantId);
    expect(first).toBe(17);

    const second = await seedE2eFixture(h.db, tenantId);
    expect(second).toBe(0);

    const products = await h.client<{ id: string }[]>`
      select id from products where tenant_id = ${tenantId}
    `;
    const variants = await h.client<{ id: string }[]>`
      select id from product_variants where tenant_id = ${tenantId}
    `;
    expect(products).toHaveLength(1);
    expect(variants).toHaveLength(2);

    // The account fixture is single-instance too (no duplicate customer / order / invoice).
    const customers = await h.client<{ id: string }[]>`
      select id from customers where tenant_id = ${tenantId} and email = ${E2E_ACCOUNT_EMAIL}
    `;
    const accountOrders = await h.client<{ id: string }[]>`
      select id from orders where tenant_id = ${tenantId} and order_number = ${E2E_ACCOUNT_ORDER_NUMBER}
    `;
    expect(customers).toHaveLength(1);
    expect(accountOrders).toHaveLength(1);
  });

  it('seeds the loginable account + its delivered order + receipt invoice', async () => {
    const tenantId = await makeTenant(h);
    await seedE2eFixture(h.db, tenantId);

    // Customer: active, with a REAL Argon2id hash so the storefront login verifies.
    const customer = await h.client<
      { id: string; password_hash: string | null; deleted_at: string | null }[]
    >`
      select id, password_hash, deleted_at from customers
      where tenant_id = ${tenantId} and email = ${E2E_ACCOUNT_EMAIL}
    `;
    expect(customer).toHaveLength(1);
    expect(customer[0]!.password_hash).toMatch(/^\$argon2id\$/);
    expect(customer[0]!.deleted_at).toBeNull();
    const customerId = customer[0]!.id;

    // Default shipping address.
    const addresses = await h.client<{ type: string; is_default: boolean; line1: string }[]>`
      select type, is_default, line1 from customer_addresses
      where tenant_id = ${tenantId} and customer_id = ${customerId}
    `;
    expect(addresses).toHaveLength(1);
    expect(addresses[0]!.type).toBe('shipping');
    expect(addresses[0]!.is_default).toBe(true);

    // Delivered order with the deterministic money the storefront renders verbatim.
    const order = await h.client<
      {
        id: string;
        status: string;
        currency: string;
        subtotal_amount: number;
        shipping_amount: number;
        tax_amount: number;
        total_amount: number;
        customer_id: string;
      }[]
    >`
      select id, status, currency, subtotal_amount, shipping_amount, tax_amount, total_amount, customer_id
      from orders where tenant_id = ${tenantId} and order_number = ${E2E_ACCOUNT_ORDER_NUMBER}
    `;
    expect(order).toHaveLength(1);
    expect(order[0]!.status).toBe('delivered');
    expect(order[0]!.currency).toBe('EUR');
    expect(order[0]!.subtotal_amount).toBe(1999);
    expect(order[0]!.shipping_amount).toBe(490);
    expect(order[0]!.tax_amount).toBe(400);
    expect(order[0]!.total_amount).toBe(2889);
    expect(order[0]!.customer_id).toBe(customerId);

    // One order item snapshotting the in-stock variant.
    const items = await h.client<
      { sku: string; quantity: number; unit_price_amount: number; line_total_amount: number }[]
    >`
      select sku, quantity, unit_price_amount, line_total_amount from order_items
      where tenant_id = ${tenantId} and order_id = ${order[0]!.id}
    `;
    expect(items).toHaveLength(1);
    expect(items[0]!.sku).toBe(E2E_VARIANT_IN_STOCK.sku);
    expect(items[0]!.quantity).toBe(1);
    expect(items[0]!.unit_price_amount).toBe(1999);

    // The receipt invoice (storage_key null → renders on demand from the snapshot).
    const invoice = await h.client<
      {
        currency: string;
        total_amount: number;
        storage_key: string | null;
        tax_breakdown: unknown;
      }[]
    >`
      select currency, total_amount, storage_key, tax_breakdown from invoices
      where tenant_id = ${tenantId} and order_id = ${order[0]!.id}
    `;
    expect(invoice).toHaveLength(1);
    expect(invoice[0]!.currency).toBe('EUR');
    expect(invoice[0]!.total_amount).toBe(2889);
    expect(invoice[0]!.storage_key).toBeNull();
    expect((invoice[0]!.tax_breakdown as { documentKind?: string }).documentKind).toBe('receipt');
  });

  it('seeds only the passed tenant (no cross-tenant rows)', async () => {
    const tenantA = await makeTenant(h);
    const tenantB = newId();
    await h.client`insert into tenants (id, name, slug) values (${tenantB}, ${'b'}, ${'tenant-b-' + tenantB.slice(-8)})`;

    await seedE2eFixture(h.db, tenantA);

    const rowsB = await h.client<{ id: string }[]>`
      select id from products where tenant_id = ${tenantB}
    `;
    expect(rowsB).toHaveLength(0);
  });
});
