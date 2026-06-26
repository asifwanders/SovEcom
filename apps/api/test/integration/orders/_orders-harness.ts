/**
 * Orders integration harness.
 *
 * Reuses the cart harness (real Postgres + Redis, full AppModule) and adds:
 *  - order-table truncation in the per-test reset,
 *  - a bundle-product seeder,
 *  - a `driveCartToCheckoutReady` helper that mirrors the storefront checkout flow
 *    (create cart → add item → shipping address → shipping method → guest email).
 */
import request from 'supertest';
import {
  resetCartState,
  seedShippingRate,
  extractCartTokenCookie,
  truncateWithRetry,
  type CartHarness,
  DEFAULT_TENANT_ID,
  newId,
} from '../cart/_cart-harness';

export {
  bootCartApp,
  seedProductWithVariants,
  seedShippingRate,
  signupAndLoginCustomer,
  seedAdminAndLogin,
  setTaxSettings,
  extractCartTokenCookie,
  DEFAULT_TENANT_ID,
  newId,
  type CartHarness,
} from '../cart/_cart-harness';

/**
 * Per-test reset: clears the order tables (+ counter) on top of the cart reset.
 *
 * `order.paid` issues an invoice via a FIRE-AND-FORGET listener (no test awaits it unless it
 * calls waitForInvoice). A still-in-flight issuance tx (holding locks on invoices /
 * invoice_counters, reading orders) can DEADLOCK this TRUNCATE (which needs ACCESS EXCLUSIVE
 * on orders, cascading to invoices). The issuance tx is sub-100ms, so we RETRY the truncate on
 * a transient deadlock — the loser rolls back (harmlessly: its order is being wiped anyway) and
 * the retry then succeeds. Test-only; never masks a real-path deadlock.
 */
export async function resetOrderState(h: CartHarness): Promise<void> {
  // Refunds + credit-note renders add more fire-and-forget post-commit lock-holders, so
  // both truncates use the robust shared deadlock-retry.
  await truncateWithRetry(
    h,
    `TRUNCATE TABLE
       payment_events, disputes, refund_line_items, refunds, payments,
       invoices, invoice_counters,
       order_status_history, order_items, orders, order_counters,
       bundle_items, inventory_reservations
     RESTART IDENTITY CASCADE`,
  );
  await resetCartState(h);
}

/** Seed a single-variant published product with a given stock + price; returns ids. */
export async function seedSimpleProduct(
  h: CartHarness,
  opts: { price?: number; stock?: number; currency?: string } = {},
): Promise<{ productId: string; variantId: string; currency: string }> {
  const productId = newId();
  const variantId = newId();
  const currency = opts.currency ?? 'EUR';
  await h.client`
    insert into products (id, tenant_id, title, slug, status)
    values (${productId}, ${DEFAULT_TENANT_ID}, ${'Simple Product'}, ${`simple-${productId}`}, ${'published'})
  `;
  await h.client`
    insert into product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity)
    values (${variantId}, ${DEFAULT_TENANT_ID}, ${productId}, ${`SKU-${variantId}`}, ${'Default'}, ${'{}'}::jsonb, ${opts.price ?? 1000}, ${currency}, ${opts.stock ?? 10})
  `;
  return { productId, variantId, currency };
}

/**
 * Seed a BUNDLE product (is_bundle=true) with its own placeholder variant plus N component
 * variants (each a separately-stocked product). Returns the bundle variant id (what the
 * customer adds to cart) + the component variant ids and their per-bundle quantities.
 */
export async function seedBundleProduct(
  h: CartHarness,
  components: { price: number; stock: number; qtyPerBundle: number }[],
  opts: { bundlePrice?: number; currency?: string } = {},
): Promise<{
  bundleProductId: string;
  bundleVariantId: string;
  componentVariantIds: string[];
  currency: string;
}> {
  const currency = opts.currency ?? 'EUR';
  const bundleProductId = newId();
  const bundleVariantId = newId();
  await h.client`
    insert into products (id, tenant_id, title, slug, status, is_bundle)
    values (${bundleProductId}, ${DEFAULT_TENANT_ID}, ${'Bundle Box'}, ${`bundle-${bundleProductId}`}, ${'published'}, ${true})
  `;
  // The bundle's own variant is a placeholder; give it allow_backorder so its own stock
  // is irrelevant (the engine consumes COMPONENTS, never the placeholder).
  await h.client`
    insert into product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity, allow_backorder)
    values (${bundleVariantId}, ${DEFAULT_TENANT_ID}, ${bundleProductId}, ${`BUNDLE-${bundleVariantId}`}, ${'Bundle'}, ${'{}'}::jsonb, ${opts.bundlePrice ?? 5000}, ${currency}, ${0}, ${true})
  `;

  const componentVariantIds: string[] = [];
  for (const c of components) {
    const cpId = newId();
    const cvId = newId();
    await h.client`
      insert into products (id, tenant_id, title, slug, status)
      values (${cpId}, ${DEFAULT_TENANT_ID}, ${'Component'}, ${`comp-${cpId}`}, ${'published'})
    `;
    await h.client`
      insert into product_variants (id, tenant_id, product_id, sku, title, options, price_amount, currency, stock_quantity)
      values (${cvId}, ${DEFAULT_TENANT_ID}, ${cpId}, ${`COMP-${cvId}`}, ${'Comp'}, ${'{}'}::jsonb, ${c.price}, ${currency}, ${c.stock})
    `;
    await h.client`
      insert into bundle_items (id, tenant_id, bundle_product_id, variant_id, quantity)
      values (${newId()}, ${DEFAULT_TENANT_ID}, ${bundleProductId}, ${cvId}, ${c.qtyPerBundle})
    `;
    componentVariantIds.push(cvId);
  }

  return { bundleProductId, bundleVariantId, componentVariantIds, currency };
}

const ADDRESS = {
  name: 'Jane Buyer',
  line1: '1 rue de Test',
  city: 'Paris',
  postalCode: '75001',
  country: 'FR',
};

/**
 * Create a guest cart and drive it to checkout-ready: add `variantId` × `qty`, set a
 * shipping address (FR), seed + select a shipping method, set a guest email. Returns the
 * cart id + token cookie so the test can POST the checkout.
 */
export async function driveCartToCheckoutReady(
  h: CartHarness,
  variantId: string,
  qty: number,
  currency = 'EUR',
): Promise<{ cartId: string; cartCookie: string }> {
  const created = await request(h.http()).post('/store/v1/carts').send({ currency });
  if (created.status !== 201) {
    throw new Error(`cart create failed: ${created.status} ${JSON.stringify(created.body)}`);
  }
  const cartId = created.body.cartId as string;
  const cartCookie = extractCartTokenCookie(created);

  const add = await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cartCookie)
    .send({ variantId, quantity: qty });
  if (add.status !== 201) {
    throw new Error(`add item failed: ${add.status} ${JSON.stringify(add.body)}`);
  }

  await seedShippingRate(h, currency);

  const addr = await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-address`)
    .set('Cookie', cartCookie)
    .send(ADDRESS);
  if (addr.status !== 200) {
    throw new Error(`set address failed: ${addr.status} ${JSON.stringify(addr.body)}`);
  }

  const rates = await request(h.http())
    .get(`/store/v1/carts/${cartId}/shipping-rates`)
    .set('Cookie', cartCookie);
  const rateId = rates.body[0]?.id as string;
  if (!rateId) throw new Error(`no shipping rate available: ${JSON.stringify(rates.body)}`);

  const method = await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-method`)
    .set('Cookie', cartCookie)
    .send({ shippingRateId: rateId });
  if (method.status !== 200) {
    throw new Error(`set method failed: ${method.status} ${JSON.stringify(method.body)}`);
  }

  const email = await request(h.http())
    .post(`/store/v1/carts/${cartId}/email`)
    .set('Cookie', cartCookie)
    .send({ email: `buyer-${Date.now()}@test.invalid` });
  if (email.status !== 200) {
    throw new Error(`set email failed: ${email.status} ${JSON.stringify(email.body)}`);
  }

  return { cartId, cartCookie };
}
