/**
 * Order creation integration tests.
 *
 * Full AppModule against real Postgres + Redis. Covers:
 *  - happy path: cart → order (totals reconcile, stock decremented, cart converted,
 *    status pending_payment, initial status-history row);
 *  - double-submit: second checkout → 409, stock consumed ONCE;
 *  - validation failures (no shipping address / empty cart) → 422;
 *  - bundle order decrements every constituent by the min-correct amount;
 *  - tenant isolation + no payment precondition.
 */
import request from 'supertest';
import {
  bootCartApp,
  resetOrderState,
  seedSimpleProduct,
  seedBundleProduct,
  driveCartToCheckoutReady,
  extractCartTokenCookie,
  seedShippingRate,
  signupAndLoginCustomer,
  setTaxSettings,
  DEFAULT_TENANT_ID,
  type CartHarness,
} from './_orders-harness';
import { seedDiscount, seedTaxRate } from '../cart/_cart-harness';

let h: CartHarness;

beforeAll(async () => {
  h = await bootCartApp();
}, 30_000);

afterAll(async () => {
  await h.app.close();
  await h.client.end();
});

beforeEach(async () => {
  await resetOrderState(h);
}, 10_000);

async function stockOf(variantId: string): Promise<number> {
  const rows = await h.client<{ stock_quantity: number }[]>`
    select stock_quantity from product_variants where id = ${variantId}
  `;
  return rows[0]!.stock_quantity;
}

describe('POST /store/v1/carts/:cartId/checkout — happy path', () => {
  it('creates a pending_payment order, decrements stock, converts the cart', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 3);

    const stockBefore = await stockOf(variantId);

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(String),
      orderNumber: expect.any(String),
      status: 'pending_payment',
      currency: 'EUR',
      subtotalAmount: 3000,
      shippingAmount: 500,
    });
    // No internal leakage.
    expect(res.body.tenantId).toBeUndefined();
    expect(res.body.metadata).toBeUndefined();

    // Totals reconcile server-side: subtotal − discount + shipping + tax (tax 'none' → 0).
    expect(res.body.totalAmount).toBe(
      res.body.subtotalAmount -
        res.body.discountAmount +
        res.body.shippingAmount +
        res.body.taxAmount,
    );

    // Stock decremented by exactly the ordered quantity.
    expect(await stockOf(variantId)).toBe(stockBefore - 3);

    // Order row persisted, pending_payment, tenant-scoped.
    const orderRows = await h.client<{ id: string; status: string; tenant_id: string }[]>`
      select id, status, tenant_id from orders where id = ${res.body.id}
    `;
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]!.status).toBe('pending_payment');
    expect(orderRows[0]!.tenant_id).toBe(DEFAULT_TENANT_ID);

    // One order item, snapshotting title + sku + price.
    const items = await h.client<
      { quantity: number; unit_price_amount: number; line_total_amount: number }[]
    >`
      select quantity, unit_price_amount, line_total_amount from order_items where order_id = ${res.body.id}
    `;
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(3);
    expect(items[0]!.unit_price_amount).toBe(1000);

    // Initial status-history row: null → pending_payment.
    const history = await h.client<{ from_status: string | null; to_status: string }[]>`
      select from_status, to_status from order_status_history where order_id = ${res.body.id}
    `;
    expect(history).toHaveLength(1);
    expect(history[0]!.from_status).toBeNull();
    expect(history[0]!.to_status).toBe('pending_payment');

    // Cart flipped to converted.
    const cart = await h.client<{ status: string }[]>`
      select status from carts where id = ${cartId}
    `;
    expect(cart[0]!.status).toBe('converted');
  });
});

describe('double-submit (idempotency guard)', () => {
  it('rejects a second checkout with 409 and consumes stock exactly once', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 2);

    const first = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});
    expect(first.status).toBe(201);
    const afterFirst = await stockOf(variantId);
    expect(afterFirst).toBe(8);

    const second = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});
    expect(second.status).toBe(409);

    // Stock unchanged by the rejected second submit, and only ONE order exists.
    expect(await stockOf(variantId)).toBe(8);
    const orders = await h.client<{ n: number }[]>`
      select count(*)::int as n from orders
    `;
    expect(orders[0]!.n).toBe(1);
  });
});

describe('validation failures → 422', () => {
  it('rejects an empty cart', async () => {
    // Create a cart, set address + a (seeded) method but add NO item → empty.
    const created = await request(h.http()).post('/store/v1/carts').send({ currency: 'EUR' });
    const cartId = created.body.cartId as string;
    const cartCookie = extractCartTokenCookie(created);
    await seedShippingRate(h, 'EUR');
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/shipping-address`)
      .set('Cookie', cartCookie)
      .send({ name: 'X', line1: '1 rue', city: 'Paris', postalCode: '75001', country: 'FR' });
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/email`)
      .set('Cookie', cartCookie)
      .send({ email: 'x@test.invalid' });

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});
    expect(res.status).toBe(422);
  });

  it('rejects a cart with no shipping address', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const created = await request(h.http()).post('/store/v1/carts').send({ currency: 'EUR' });
    const cartId = created.body.cartId as string;
    const cartCookie = extractCartTokenCookie(created);
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/items`)
      .set('Cookie', cartCookie)
      .send({ variantId, quantity: 1 });
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/email`)
      .set('Cookie', cartCookie)
      .send({ email: 'x@test.invalid' });

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});
    expect(res.status).toBe(422);
    // Nothing consumed: the variant's stock is untouched.
    expect(await stockOf(variantId)).toBe(10);
  });
});

describe('authorisation', () => {
  it('rejects checkout without the cart token or customer JWT (403)', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId } = await driveCartToCheckoutReady(h, variantId, 1);
    const res = await request(h.http()).post(`/store/v1/carts/${cartId}/checkout`).send({});
    expect(res.status).toBe(403);
  });
});

// ── No oversell / no silent zero-decrement when the cart's reservations were swept
//    (TTL expiry) or never cover the ordered qty. ──
describe('checkout with SWEPT / missing reservations (no oversell)', () => {
  it('decrements from PHYSICAL stock (not the swept reservation) — never silently zero', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 3);

    // Simulate the inventory-sweeper: the cart sat idle past the TTL, its reservation
    // was deleted. The OLD code flipped zero 'reserved' rows → ZERO decrement (oversell).
    await h.client`delete from inventory_reservations where cart_id = ${cartId}`;
    const stockBefore = await stockOf(variantId); // 10

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});

    expect(res.status).toBe(201);
    // Stock decremented by the ordered qty from physical stock — NOT left at 10.
    expect(await stockOf(variantId)).toBe(stockBefore - 3);
  });

  it('409s (not a negative-stock oversell) when physical stock cannot cover the order', async () => {
    // Stock only 2 but the cart ordered 3; its reservation was swept before checkout.
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 3 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 3);

    // Drop the reservation, then drain physical stock to 2 (e.g. another sale landed).
    await h.client`delete from inventory_reservations where cart_id = ${cartId}`;
    await h.client`update product_variants set stock_quantity = 2 where id = ${variantId}`;

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});

    expect(res.status).toBe(409);
    // No decrement, never negative, no order, cart not converted (whole tx rolled back).
    expect(await stockOf(variantId)).toBe(2);
    const orders = await h.client<{ n: number }[]>`select count(*)::int as n from orders`;
    expect(orders[0]!.n).toBe(0);
    const cart = await h.client<
      { status: string }[]
    >`select status from carts where id = ${cartId}`;
    expect(cart[0]!.status).toBe('active');
  });
});

// ── Taxed shipping must NOT smear into per-line goods tax; the
//    per-line tax_rate is the statutory destination rate. ──
describe('taxed shipping does not blow up per-line tax_rate', () => {
  it('FR 20%, 50c item + €30 taxed shipping → line rate 0.2000, no 500, reconciles', async () => {
    await setTaxSettings(h, {
      taxMode: 'eu_vat',
      pricesIncludeTax: false,
      originCountry: 'FR',
      ossPosture: 'below_threshold',
    });
    // Seed the FR 20% standard rate the engine resolves against.
    await seedTaxRate(h, 'FR', '0.2000');
    // A 50-cent item; shipping rate seeded by the harness is €5 (500) — taxed too.
    const { variantId } = await seedSimpleProduct(h, { price: 50, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 1);

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});

    // The OLD blended rate (lineTax/lineNet) would exceed numeric(5,4) → INSERT 500.
    expect(res.status).toBe(201);

    // Per-line tax_rate is the STATUTORY 0.2000, not a blended overflow.
    const items = await h.client<{ tax_rate: string; tax_amount: number }[]>`
      select tax_rate, tax_amount from order_items where order_id = ${res.body.id}
    `;
    expect(items).toHaveLength(1);
    expect(Number(items[0]!.tax_rate)).toBeCloseTo(0.2, 4);

    // Items tax = round(50 * 0.2) = 10; shipping tax = round(500 * 0.2) = 100.
    expect(items[0]!.tax_amount).toBe(10); // line tax is ITEMS tax only — not 10+100
    // order.tax_total == items tax + shipping tax; sum(line tax) == items tax.
    expect(res.body.taxAmount).toBe(10 + 100);
    expect(res.body.totalAmount).toBe(
      res.body.subtotalAmount -
        res.body.discountAmount +
        res.body.shippingAmount +
        res.body.taxAmount,
    );
  });
});

// ── A selected shipping method that vanished must 422, not silently create a 0-shipping order. ──
describe('vanished shipping method (422, not silent 0)', () => {
  it('422s when the cart selected a method that is no longer available, no order, no decrement', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, variantId, 2);

    // The selected rate (and its zone) vanish between cart-build and checkout. The in-tx
    // recompute nulls the now-invalid rate; B4 turns that into a 422 rather than 0-shipping.
    await h.client`delete from shipping_rates`;
    await h.client`delete from shipping_zones`;

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});

    expect(res.status).toBe(422);
    // No order, no stock decrement, cart still active (whole tx rolled back).
    expect(await stockOf(variantId)).toBe(10);
    const orders = await h.client<{ n: number }[]>`select count(*)::int as n from orders`;
    expect(orders[0]!.n).toBe(0);
    const cart = await h.client<
      { status: string }[]
    >`select status from carts where id = ${cartId}`;
    expect(cart[0]!.status).toBe('active');
  });
});

describe('bundle expansion (FR-CAT-006)', () => {
  it('decrements every constituent by qtyPerBundle × line qty', async () => {
    // Bundle of 2 components: A (×2 per bundle), B (×1 per bundle).
    const { bundleVariantId, componentVariantIds } = await seedBundleProduct(
      h,
      [
        { price: 1000, stock: 20, qtyPerBundle: 2 },
        { price: 2000, stock: 20, qtyPerBundle: 1 },
      ],
      { bundlePrice: 4000 },
    );
    const [compA, compB] = componentVariantIds;

    const aBefore = await stockOf(compA!);
    const bBefore = await stockOf(compB!);
    const bundleStockBefore = await stockOf(bundleVariantId);

    // Order 3 bundles.
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, bundleVariantId, 3);
    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});
    expect(res.status).toBe(201);

    // Components decremented by qtyPerBundle × 3.
    expect(await stockOf(compA!)).toBe(aBefore - 2 * 3);
    expect(await stockOf(compB!)).toBe(bBefore - 1 * 3);
    // The bundle placeholder variant's OWN stock is NOT decremented.
    expect(await stockOf(bundleVariantId)).toBe(bundleStockBefore);

    // The priced order line is the bundle parent (price 4000 × 3), not the components.
    expect(res.body.subtotalAmount).toBe(4000 * 3);
    const items = await h.client<{ n: number }[]>`
      select count(*)::int as n from order_items where order_id = ${res.body.id}
    `;
    expect(items[0]!.n).toBe(1);
  });

  it('rejects a bundle order that would oversell a constituent (409), no partial decrement', async () => {
    // Component A has only 2 in stock but the bundle needs 2 per unit → ordering 2 bundles
    // (needs 4) oversells.
    const { bundleVariantId, componentVariantIds } = await seedBundleProduct(
      h,
      [
        { price: 1000, stock: 2, qtyPerBundle: 2 },
        { price: 2000, stock: 50, qtyPerBundle: 1 },
      ],
      { bundlePrice: 4000 },
    );
    const [compA, compB] = componentVariantIds;
    const { cartId, cartCookie } = await driveCartToCheckoutReady(h, bundleVariantId, 2);

    const res = await request(h.http())
      .post(`/store/v1/carts/${cartId}/checkout`)
      .set('Cookie', cartCookie)
      .send({});
    expect(res.status).toBe(409);

    // The whole tx rolled back: NEITHER component was decremented, no order exists.
    expect(await stockOf(compA!)).toBe(2);
    expect(await stockOf(compB!)).toBe(50);
    const orders = await h.client<{ n: number }[]>`select count(*)::int as n from orders`;
    expect(orders[0]!.n).toBe(0);
    const cart = await h.client<
      { status: string }[]
    >`select status from carts where id = ${cartId}`;
    expect(cart[0]!.status).toBe('active'); // not converted on failure
  });
});

// ── Discount usage-consume + segments ───────────────

/**
 * Drive a CUSTOMER cart to checkout-ready: associate `accessToken` to the cart (so the
 * cart owner is the customer, which is what the discount engine + usage-consume key off),
 * add `variantId` × qty, set address + method + (the customer's) email. Optionally apply
 * an explicit discount code first. Returns the cart id + cookie.
 */
async function driveCustomerCartToCheckoutReady(
  variantId: string,
  qty: number,
  accessToken: string,
  opts: { discountCode?: string } = {},
): Promise<{ cartId: string; cartCookie: string }> {
  const created = await request(h.http()).post('/store/v1/carts').send({ currency: 'EUR' });
  const cartId = created.body.cartId as string;
  const cartCookie = extractCartTokenCookie(created);

  // Associate the customer FIRST so cart.customerId is set for discount evaluation.
  const assoc = await request(h.http())
    .post(`/store/v1/carts/${cartId}/customer`)
    .set('Cookie', cartCookie)
    .set('Authorization', `Bearer ${accessToken}`);
  if (assoc.status !== 200) {
    throw new Error(`associate failed: ${assoc.status} ${JSON.stringify(assoc.body)}`);
  }

  await request(h.http())
    .post(`/store/v1/carts/${cartId}/items`)
    .set('Cookie', cartCookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ variantId, quantity: qty })
    .expect(201);

  await seedShippingRate(h, 'EUR');

  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-address`)
    .set('Cookie', cartCookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name: 'Buyer', line1: '1 rue', city: 'Paris', postalCode: '75001', country: 'FR' })
    .expect(200);

  const rates = await request(h.http())
    .get(`/store/v1/carts/${cartId}/shipping-rates`)
    .set('Cookie', cartCookie)
    .set('Authorization', `Bearer ${accessToken}`);
  await request(h.http())
    .post(`/store/v1/carts/${cartId}/shipping-method`)
    .set('Cookie', cartCookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ shippingRateId: rates.body[0].id })
    .expect(200);

  await request(h.http())
    .post(`/store/v1/carts/${cartId}/email`)
    .set('Cookie', cartCookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ email: `buyer-${Date.now()}@test.invalid` })
    .expect(200);

  if (opts.discountCode) {
    await request(h.http())
      .post(`/store/v1/carts/${cartId}/discounts`)
      .set('Cookie', cartCookie)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: opts.discountCode })
      .expect(200);
  }

  return { cartId, cartCookie };
}

function checkout(cartId: string, cartCookie: string, accessToken: string) {
  return request(h.http())
    .post(`/store/v1/carts/${cartId}/checkout`)
    .set('Cookie', cartCookie)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({});
}

describe('discount usage-consume on order confirm', () => {
  it('writes a discount_usages row + increments used_count when a code applies', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 10 });
    const { accessToken, customerId } = await signupAndLoginCustomer(h);
    // 10% off everything, explicit code.
    const discountId = await seedDiscount(h, { code: 'SAVE10', type: 'percentage', value: 1000 });

    const { cartId, cartCookie } = await driveCustomerCartToCheckoutReady(
      variantId,
      2,
      accessToken,
      { discountCode: 'SAVE10' },
    );
    const res = await checkout(cartId, cartCookie, accessToken);
    expect(res.status).toBe(201);
    // subtotal 2000, 10% → discount 200.
    expect(res.body.subtotalAmount).toBe(2000);
    expect(res.body.discountAmount).toBe(200);

    // Exactly one usage row, amount == the order's discount, scoped to this order+customer.
    const usages = await h.client<{ amount: number; customer_id: string; order_id: string }[]>`
      select amount, customer_id, order_id from discount_usages where discount_id = ${discountId}
    `;
    expect(usages).toHaveLength(1);
    expect(usages[0]!.amount).toBe(200);
    expect(usages[0]!.customer_id).toBe(customerId);
    expect(usages[0]!.order_id).toBe(res.body.id);

    // used_count bumped to 1, and equals count(discount_usages) — the core invariant.
    const disc = await h.client<{ used_count: number }[]>`
      select used_count from discounts where id = ${discountId}
    `;
    expect(disc[0]!.used_count).toBe(1);
  });

  it('B2 — sum(discount_usages.amount) == order.discountAmount (single eval)', async () => {
    // Two stackable discounts so the order discount is the SUM of multiple usages — the
    // invariant must hold across the whole applied[] derived from the SINGLE in-tx eval.
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 50 });
    const { accessToken } = await signupAndLoginCustomer(h);
    // Explicit 10% code + an automatic stackable €1 (100) off — both apply, both record.
    await seedDiscount(h, { code: 'TEN', type: 'percentage', value: 1000, stackable: true });
    await seedDiscount(h, {
      code: null,
      type: 'fixed',
      value: 100,
      currency: 'EUR',
      stackable: true,
    });

    const { cartId, cartCookie } = await driveCustomerCartToCheckoutReady(
      variantId,
      2,
      accessToken,
      { discountCode: 'TEN' },
    );
    const res = await checkout(cartId, cartCookie, accessToken);
    expect(res.status).toBe(201);
    expect(res.body.discountAmount).toBeGreaterThan(0);

    // The headline invariant: redemptions recorded sum EXACTLY to the order's discount.
    const usages = await h.client<{ s: number | null }[]>`
      select sum(amount)::int as s from discount_usages where order_id = ${res.body.id}
    `;
    expect(usages[0]!.s).toBe(res.body.discountAmount);
  });

  it("a usage_limit_per_customer=1 discount blocks the SAME customer's 2nd order", async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 50 });
    const { accessToken } = await signupAndLoginCustomer(h);
    const discountId = await seedDiscount(h, {
      code: 'ONCE',
      type: 'percentage',
      value: 1000,
      usage_limit_per_customer: 1,
    });

    // First order: the code applies and is consumed.
    const first = await driveCustomerCartToCheckoutReady(variantId, 1, accessToken, {
      discountCode: 'ONCE',
    });
    const r1 = await checkout(first.cartId, first.cartCookie, accessToken);
    expect(r1.status).toBe(201);
    expect(r1.body.discountAmount).toBe(100);

    // Second order: the per-customer limit is now exhausted. Applying the code on the
    // cart is REJECTED at apply-time (422 — the engine sees the prior usage), so the
    // 2nd order simply gets NO discount. Either way the limit is never exceeded.
    const second = await request(h.http()).post('/store/v1/carts').send({ currency: 'EUR' });
    const cart2 = second.body.cartId as string;
    const cookie2 = extractCartTokenCookie(second);
    await request(h.http())
      .post(`/store/v1/carts/${cart2}/customer`)
      .set('Cookie', cookie2)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    await request(h.http())
      .post(`/store/v1/carts/${cart2}/items`)
      .set('Cookie', cookie2)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ variantId, quantity: 1 })
      .expect(201);
    const apply = await request(h.http())
      .post(`/store/v1/carts/${cart2}/discounts`)
      .set('Cookie', cookie2)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: 'ONCE' });
    expect(apply.status).toBe(422); // ineligible — per-customer limit hit

    // Exactly ONE usage row + used_count 1 — the limit held.
    const usages = await h.client<{ n: number }[]>`
      select count(*)::int as n from discount_usages where discount_id = ${discountId}
    `;
    expect(usages[0]!.n).toBe(1);
    const disc = await h.client<{ used_count: number }[]>`
      select used_count from discounts where id = ${discountId}
    `;
    expect(disc[0]!.used_count).toBe(1);
  });

  it('a first_time AUTO discount applies on the 1st order but NOT the 2nd', async () => {
    const { variantId } = await seedSimpleProduct(h, { price: 1000, stock: 50 });
    const { accessToken } = await signupAndLoginCustomer(h);
    // Automatic (null code) first_time discount — always evaluated, no code to apply.
    const discountId = await seedDiscount(h, {
      code: null,
      type: 'percentage',
      value: 1000,
      customer_segment: 'first_time',
    });

    // 1st order: customer has no prior order → first_time applies.
    const first = await driveCustomerCartToCheckoutReady(variantId, 1, accessToken);
    const r1 = await checkout(first.cartId, first.cartCookie, accessToken);
    expect(r1.status).toBe(201);
    expect(r1.body.discountAmount).toBe(100);

    // 2nd order: the customer now has a prior order → first_time no longer applies.
    const second = await driveCustomerCartToCheckoutReady(variantId, 1, accessToken);
    const r2 = await checkout(second.cartId, second.cartCookie, accessToken);
    expect(r2.status).toBe(201);
    expect(r2.body.discountAmount).toBe(0);

    // Only the 1st order consumed a redemption.
    const usages = await h.client<{ n: number }[]>`
      select count(*)::int as n from discount_usages where discount_id = ${discountId}
    `;
    expect(usages[0]!.n).toBe(1);
    const disc = await h.client<{ used_count: number }[]>`
      select used_count from discounts where id = ${discountId}
    `;
    expect(disc[0]!.used_count).toBe(1);
  });
});
