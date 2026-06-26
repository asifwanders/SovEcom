/**
 * Commerce schema integration. SECURITY / MONEY / LEGAL-CRITICAL.
 *
 * Asserts, against a real Postgres:
 *  - migration 0005 applies; all 17 new tables + 11 new enums exist.
 *  - `order_items.variant_id` is ON DELETE SET NULL (the DGFIP-legal one): deleting a
 *    sold variant nulls ONLY variant_id; tenant_id + the snapshot columns survive.
 *  - composite-FK cross-tenant write rejection on the new child tables.
 *  - money columns are integer; currency char_length=3 CHECK; non-negative-money CHECKs.
 *  - enums reject invalid values.
 *  - invoice_counters present w/ its PK; customers.token_version present, default 0.
 *  - order_number MAY gap vs invoice_number gapless — the UNIQUE constraints exist.
 */
import { connect, migrateUp, truncateAll, makeTenant, newId, Sql, Db } from './_harness';

const NEW_TABLES = [
  'inventory_reservations',
  'carts',
  'cart_items',
  'orders',
  'order_items',
  'order_status_history',
  'invoices',
  'invoice_counters',
  'returns',
  'payments',
  'refunds',
  'refund_line_items',
  'discounts',
  'discount_usages',
  'tax_rates',
  'shipping_zones',
  'shipping_rates',
];

const NEW_ENUMS = [
  'reservation_status',
  'cart_status',
  'order_status',
  'invoice_type',
  'return_type',
  'return_status',
  'payment_status',
  'refund_status',
  'discount_type',
  'discount_scope',
  'shipping_rate_type',
];

async function expectFkViolation(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: '23503' });
}
async function expectCheckViolation(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: '23514' });
}
/** Invalid-enum-input surfaces as SQLSTATE 22P02 (invalid_text_representation). */
async function expectEnumViolation(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: '22P02' });
}

describe('I9 commerce schema — SECURITY/MONEY/LEGAL-CRITICAL (integration)', () => {
  let client: Sql;
  let db: Db;
  let A: string;
  let B: string;

  beforeAll(async () => {
    ({ client, db } = connect());
    await migrateUp(db);
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(client);
    A = await makeTenant(client, `c9-a-${newId().slice(0, 8)}`);
    B = await makeTenant(client, `c9-b-${newId().slice(0, 8)}`);
  });

  // ---- fixture builders (owned by a specific tenant) -----------------------
  async function product(tenant: string, slug: string): Promise<string> {
    const id = newId();
    await client`insert into products (id, tenant_id, title, slug, status) values (${id}, ${tenant}, ${'P'}, ${slug}, ${'published'})`;
    return id;
  }
  async function variant(tenant: string, productId: string, sku: string): Promise<string> {
    const id = newId();
    await client`
      insert into product_variants (id, tenant_id, product_id, sku, options, price_amount, currency, stock_quantity)
      values (${id}, ${tenant}, ${productId}, ${sku}, ${'{}'}::jsonb, ${1000}, ${'EUR'}, ${5})
    `;
    return id;
  }
  async function customer(tenant: string, email: string): Promise<string> {
    const id = newId();
    await client`insert into customers (id, tenant_id, email, name) values (${id}, ${tenant}, ${email}, ${'C'})`;
    return id;
  }
  async function cart(tenant: string): Promise<string> {
    const id = newId();
    await client`
      insert into carts (id, tenant_id, currency, expires_at)
      values (${id}, ${tenant}, ${'EUR'}, ${client`now() + interval '1 day'`})
    `;
    return id;
  }
  async function order(tenant: string, orderNumber: string): Promise<string> {
    const id = newId();
    await client`
      insert into orders (id, tenant_id, order_number, email, currency, subtotal_amount, total_amount, tax_inclusive, shipping_address, billing_address)
      values (${id}, ${tenant}, ${orderNumber}, ${'o@x.test'}, ${'EUR'}, ${1000}, ${1200}, ${true}, ${'{}'}::jsonb, ${'{}'}::jsonb)
    `;
    return id;
  }
  async function orderItem(
    tenant: string,
    orderId: string,
    variantId: string | null,
  ): Promise<string> {
    const id = newId();
    await client`
      insert into order_items (id, tenant_id, order_id, variant_id, product_title, sku, quantity, unit_price_amount, tax_rate, tax_amount, line_total_amount)
      values (${id}, ${tenant}, ${orderId}, ${variantId}, ${'Snapshot Title'}, ${'SNAP-SKU'}, ${2}, ${1000}, ${'0.2000'}, ${400}, ${2400})
    `;
    return id;
  }
  async function payment(tenant: string, orderId: string): Promise<string> {
    const id = newId();
    await client`
      insert into payments (id, tenant_id, order_id, provider, amount, currency)
      values (${id}, ${tenant}, ${orderId}, ${'manual'}, ${1200}, ${'EUR'})
    `;
    return id;
  }
  async function refund(tenant: string, orderId: string, paymentId: string): Promise<string> {
    const id = newId();
    await client`
      insert into refunds (id, tenant_id, order_id, payment_id, amount, currency)
      values (${id}, ${tenant}, ${orderId}, ${paymentId}, ${500}, ${'EUR'})
    `;
    return id;
  }
  async function discount(tenant: string, code: string): Promise<string> {
    const id = newId();
    await client`
      insert into discounts (id, tenant_id, code, name, type, value)
      values (${id}, ${tenant}, ${code}, ${'Test Discount'}, ${'percentage'}, ${1000})
    `;
    return id;
  }

  // ===========================================================================
  // 1. Migration shape
  // ===========================================================================
  it('migration 0005 creates all 17 commerce tables', async () => {
    const rows = await client<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;
    const present = new Set(rows.map((r) => r.table_name));
    for (const t of NEW_TABLES) expect(present.has(t)).toBe(true);
    expect(NEW_TABLES.length).toBe(17);
  });

  it('registers all 11 new commerce enums', async () => {
    const rows = await client<
      { typname: string }[]
    >`select typname from pg_type where typtype = 'e'`;
    const present = new Set(rows.map((r) => r.typname));
    for (const e of NEW_ENUMS) expect(present.has(e)).toBe(true);
  });

  it('customers.token_version exists and defaults to 0', async () => {
    const cols = await client<{ column_default: string | null; is_nullable: string }[]>`
      select column_default, is_nullable from information_schema.columns
      where table_name = 'customers' and column_name = 'token_version'
    `;
    expect(cols.length).toBe(1);
    expect(cols[0].is_nullable).toBe('NO');
    const cust = await customer(A, 'tv@x.test');
    const row = await client<
      { token_version: number }[]
    >`select token_version from customers where id = ${cust}`;
    expect(row[0].token_version).toBe(0);
  });

  it('invoice_counters has its composite PK (tenant_id, series)', async () => {
    const rows = await client<{ attname: string }[]>`
      select a.attname
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'invoice_counters'::regclass and i.indisprimary
      order by a.attname
    `;
    expect(rows.map((r) => r.attname).sort()).toEqual(['series', 'tenant_id']);
  });

  // ===========================================================================
  // 2. THE LEGAL ONE — order_items.variant_id ON DELETE SET NULL
  // ===========================================================================
  it('order_items.variant_id is ON DELETE SET NULL: deleting a sold variant keeps tenant_id + snapshot', async () => {
    const prod = await product(A, 'sold-prod');
    const varId = await variant(A, prod, 'SOLD-SKU');
    const ord = await order(A, 'FR2026-0001');
    const itemId = await orderItem(A, ord, varId);

    await client`delete from product_variants where id = ${varId}`;

    const rows = await client<
      {
        variant_id: string | null;
        tenant_id: string;
        product_title: string;
        sku: string;
        unit_price_amount: number;
        tax_rate: string;
      }[]
    >`select variant_id, tenant_id, product_title, sku, unit_price_amount, tax_rate
       from order_items where id = ${itemId}`;
    expect(rows.length).toBe(1);
    const row = rows[0];
    // variant_id nulled...
    expect(row.variant_id).toBeNull();
    // ...but tenant_id (NOT NULL) survives — this is the column-specific SET NULL (variant_id)
    expect(row.tenant_id).toBe(A);
    // ...and the fiscal snapshot is intact (invoice line legally preserved)
    expect(row.product_title).toBe('Snapshot Title');
    expect(row.sku).toBe('SNAP-SKU');
    expect(row.unit_price_amount).toBe(1000);
    expect(Number(row.tax_rate)).toBeCloseTo(0.2, 4);
  });

  // ===========================================================================
  // 3. Composite-FK cross-tenant write rejection on the new child tables
  // ===========================================================================
  it('cart_items — variant/cart owned by B with tenant_id=A is REJECTED; same tenant OK', async () => {
    const prodB = await product(B, 'ci-b');
    const varB = await variant(B, prodB, 'CI-B');
    const cartA = await cart(A);
    const ins = (tenant: string, cartId: string, variantId: string) => client`
      insert into cart_items (id, tenant_id, cart_id, variant_id, quantity, unit_price_amount, currency)
      values (${newId()}, ${tenant}, ${cartId}, ${variantId}, ${1}, ${1000}, ${'EUR'})
    `;
    await expectFkViolation(ins(A, cartA, varB)); // variant belongs to B
    const prodA = await product(A, 'ci-a');
    const varA = await variant(A, prodA, 'CI-A');
    await expect(ins(A, cartA, varA)).resolves.toBeDefined();
  });

  it('inventory_reservations — cross-tenant variant/cart is REJECTED; same tenant OK', async () => {
    const prodB = await product(B, 'ir-b');
    const varB = await variant(B, prodB, 'IR-B');
    const cartA = await cart(A);
    const ins = (tenant: string, variantId: string, cartId: string) => client`
      insert into inventory_reservations (id, tenant_id, variant_id, cart_id, quantity, expires_at)
      values (${newId()}, ${tenant}, ${variantId}, ${cartId}, ${1}, ${client`now() + interval '1 hour'`})
    `;
    await expectFkViolation(ins(A, varB, cartA));
    const prodA = await product(A, 'ir-a');
    const varA = await variant(A, prodA, 'IR-A');
    await expect(ins(A, varA, cartA)).resolves.toBeDefined();
  });

  it('order_items — order owned by B with tenant_id=A is REJECTED; same tenant OK', async () => {
    const ordB = await order(B, 'FR2026-B1');
    await expectFkViolation(orderItem(A, ordB, null));
    const ordA = await order(A, 'FR2026-A1');
    await expect(orderItem(A, ordA, null)).resolves.toBeDefined();
  });

  it('invoices — order owned by B with tenant_id=A is REJECTED; same tenant OK', async () => {
    const ordB = await order(B, 'FR2026-IB');
    const ins = (tenant: string, orderId: string) => client`
      insert into invoices (id, tenant_id, order_id, series, invoice_number, issued_at, seller_snapshot, buyer_snapshot, currency, subtotal_amount, tax_breakdown, tax_amount, total_amount)
      values (${newId()}, ${tenant}, ${orderId}, ${'FR2026'}, ${'1'}, ${client`now()`}, ${'{}'}::jsonb, ${'{}'}::jsonb, ${'EUR'}, ${1000}, ${'{}'}::jsonb, ${200}, ${1200})
    `;
    await expectFkViolation(ins(A, ordB));
    const ordA = await order(A, 'FR2026-IA');
    await expect(ins(A, ordA)).resolves.toBeDefined();
  });

  it('refunds — order/payment owned by B with tenant_id=A is REJECTED; same tenant OK', async () => {
    const ordB = await order(B, 'FR2026-RB');
    const payB = await payment(B, ordB);
    const ordA = await order(A, 'FR2026-RA');
    const payA = await payment(A, ordA);
    const ins = (tenant: string, orderId: string, paymentId: string) => client`
      insert into refunds (id, tenant_id, order_id, payment_id, amount, currency)
      values (${newId()}, ${tenant}, ${orderId}, ${paymentId}, ${100}, ${'EUR'})
    `;
    await expectFkViolation(ins(A, ordB, payA)); // order belongs to B
    await expectFkViolation(ins(A, ordA, payB)); // payment belongs to B
    await expect(ins(A, ordA, payA)).resolves.toBeDefined();
  });

  it('refund_line_items — refund/order_item owned by B with tenant_id=A is REJECTED; same tenant OK', async () => {
    const ordB = await order(B, 'FR2026-RLB');
    const payB = await payment(B, ordB);
    const refB = await refund(B, ordB, payB);
    const itemB = await orderItem(B, ordB, null);

    const ordA = await order(A, 'FR2026-RLA');
    const payA = await payment(A, ordA);
    const refA = await refund(A, ordA, payA);
    const itemA = await orderItem(A, ordA, null);

    const ins = (tenant: string, refundId: string, orderItemId: string) => client`
      insert into refund_line_items (id, tenant_id, refund_id, order_item_id, quantity, amount)
      values (${newId()}, ${tenant}, ${refundId}, ${orderItemId}, ${1}, ${500})
    `;
    await expectFkViolation(ins(A, refB, itemA)); // refund belongs to B
    await expectFkViolation(ins(A, refA, itemB)); // order_item belongs to B
    await expect(ins(A, refA, itemA)).resolves.toBeDefined();
  });

  it('returns — order owned by B with tenant_id=A is REJECTED; same tenant OK', async () => {
    const ordB = await order(B, 'FR2026-RETB');
    const ins = (tenant: string, orderId: string) => client`
      insert into returns (id, tenant_id, order_id, type, items, requested_at)
      values (${newId()}, ${tenant}, ${orderId}, ${'return'}, ${'[]'}::jsonb, ${client`now()`})
    `;
    await expectFkViolation(ins(A, ordB));
    const ordA = await order(A, 'FR2026-RETA');
    await expect(ins(A, ordA)).resolves.toBeDefined();
  });

  it('discount_usages — discount/order owned by B with tenant_id=A is REJECTED; same tenant OK', async () => {
    const discB = await discount(B, 'SAVE-B');
    const ordB = await order(B, 'FR2026-DUB');
    const discA = await discount(A, 'SAVE-A');
    const ordA = await order(A, 'FR2026-DUA');
    const ins = (tenant: string, discountId: string, orderId: string) => client`
      insert into discount_usages (id, tenant_id, discount_id, order_id, amount)
      values (${newId()}, ${tenant}, ${discountId}, ${orderId}, ${100})
    `;
    await expectFkViolation(ins(A, discB, ordA)); // discount belongs to B
    await expectFkViolation(ins(A, discA, ordB)); // order belongs to B
    await expect(ins(A, discA, ordA)).resolves.toBeDefined();
  });

  // ---- 3b. Regression cover for composite FKs whose DDL is already composite ----

  it('carts.customer_id — cart(tenant=A) referencing a B-owned customer is REJECTED; same tenant OK', async () => {
    const custB = await customer(B, 'cart-b@x.test');
    const ins = (tenant: string, customerId: string) => client`
      insert into carts (id, tenant_id, customer_id, currency, expires_at)
      values (${newId()}, ${tenant}, ${customerId}, ${'EUR'}, ${client`now() + interval '1 day'`})
    `;
    await expectFkViolation(ins(A, custB));
    const custA = await customer(A, 'cart-a@x.test');
    await expect(ins(A, custA)).resolves.toBeDefined();
  });

  it('orders.customer_id — order(tenant=A) referencing a B-owned customer is REJECTED; same tenant OK', async () => {
    const custB = await customer(B, 'ord-b@x.test');
    const ins = (tenant: string, customerId: string, num: string) => client`
      insert into orders (id, tenant_id, order_number, customer_id, email, currency, subtotal_amount, total_amount, tax_inclusive, shipping_address, billing_address)
      values (${newId()}, ${tenant}, ${num}, ${customerId}, ${'o@x.test'}, ${'EUR'}, ${1000}, ${1200}, ${true}, ${'{}'}::jsonb, ${'{}'}::jsonb)
    `;
    await expectFkViolation(ins(A, custB, 'FR2026-OCB'));
    const custA = await customer(A, 'ord-a@x.test');
    await expect(ins(A, custA, 'FR2026-OCA')).resolves.toBeDefined();
  });

  it('payments.order_id — payment(tenant=A) referencing a B-owned order is REJECTED; same tenant OK', async () => {
    const ordB = await order(B, 'FR2026-POB');
    await expectFkViolation(payment(A, ordB));
    const ordA = await order(A, 'FR2026-POA');
    await expect(payment(A, ordA)).resolves.toBeDefined();
  });

  it('order_status_history — order/changed_by owned by B with tenant_id=A is REJECTED; same tenant OK', async () => {
    const userB = newId();
    await client`insert into users (id, tenant_id, email, password_hash, name, role) values (${userB}, ${B}, ${'osh-b@x.test'}, ${'$argon2id$v=19$m=1$a$b'}, ${'U'}, ${'admin'})`;
    const ordB = await order(B, 'FR2026-OSHB');
    const userA = newId();
    await client`insert into users (id, tenant_id, email, password_hash, name, role) values (${userA}, ${A}, ${'osh-a@x.test'}, ${'$argon2id$v=19$m=1$a$b'}, ${'U'}, ${'admin'})`;
    const ordA = await order(A, 'FR2026-OSHA');
    const ins = (tenant: string, orderId: string, changedBy: string) => client`
      insert into order_status_history (id, tenant_id, order_id, to_status, changed_by)
      values (${newId()}, ${tenant}, ${orderId}, ${'paid'}, ${changedBy})
    `;
    await expectFkViolation(ins(A, ordB, userA)); // order belongs to B
    await expectFkViolation(ins(A, ordA, userB)); // changed_by belongs to B
    await expect(ins(A, ordA, userA)).resolves.toBeDefined();
  });

  it('shipping_rates.zone_id — rate(tenant=A) referencing a B-owned zone is REJECTED; same tenant OK', async () => {
    const zoneB = newId();
    await client`insert into shipping_zones (id, tenant_id, name, countries) values (${zoneB}, ${B}, ${'ZB'}, ${'["FR"]'}::jsonb)`;
    const ins = (tenant: string, zoneId: string) => client`
      insert into shipping_rates (id, tenant_id, zone_id, name, type, amount, currency)
      values (${newId()}, ${tenant}, ${zoneId}, ${'R'}, ${'flat'}, ${490}, ${'EUR'})
    `;
    await expectFkViolation(ins(A, zoneB));
    const zoneA = newId();
    await client`insert into shipping_zones (id, tenant_id, name, countries) values (${zoneA}, ${A}, ${'ZA'}, ${'["FR"]'}::jsonb)`;
    await expect(ins(A, zoneA)).resolves.toBeDefined();
  });

  it('returns — customer/resolved_by/refund owned by B with tenant_id=A is REJECTED; same tenant OK', async () => {
    const custB = await customer(B, 'ret-b@x.test');
    const userB = newId();
    await client`insert into users (id, tenant_id, email, password_hash, name, role) values (${userB}, ${B}, ${'ret-u-b@x.test'}, ${'$argon2id$v=19$m=1$a$b'}, ${'U'}, ${'admin'})`;
    const ordB = await order(B, 'FR2026-RETXB');
    const payB = await payment(B, ordB);
    const refB = await refund(B, ordB, payB);

    const ordA = await order(A, 'FR2026-RETXA');
    const custA = await customer(A, 'ret-a@x.test');
    const userA = newId();
    await client`insert into users (id, tenant_id, email, password_hash, name, role) values (${userA}, ${A}, ${'ret-u-a@x.test'}, ${'$argon2id$v=19$m=1$a$b'}, ${'U'}, ${'admin'})`;
    const payA = await payment(A, ordA);
    const refA = await refund(A, ordA, payA);

    const ins = (
      tenant: string,
      orderId: string,
      customerId: string | null,
      resolvedBy: string | null,
      refundId: string | null,
    ) => client`
      insert into returns (id, tenant_id, order_id, customer_id, resolved_by, refund_id, type, items, requested_at)
      values (${newId()}, ${tenant}, ${orderId}, ${customerId}, ${resolvedBy}, ${refundId}, ${'return'}, ${'[]'}::jsonb, ${client`now()`})
    `;
    await expectFkViolation(ins(A, ordA, custB, null, null)); // customer belongs to B
    await expectFkViolation(ins(A, ordA, null, userB, null)); // resolved_by belongs to B
    await expectFkViolation(ins(A, ordA, null, null, refB)); // refund belongs to B
    await expect(ins(A, ordA, custA, userA, refA)).resolves.toBeDefined();
  });

  it('invoices.corrects_invoice_id — credit-note(tenant=A) referencing a B-owned invoice is REJECTED; same tenant OK', async () => {
    const ordB = await order(B, 'FR2026-CIB');
    const invB = newId();
    await client`
      insert into invoices (id, tenant_id, order_id, series, invoice_number, issued_at, seller_snapshot, buyer_snapshot, currency, subtotal_amount, tax_breakdown, tax_amount, total_amount)
      values (${invB}, ${B}, ${ordB}, ${'FR2026'}, ${'1'}, ${client`now()`}, ${'{}'}::jsonb, ${'{}'}::jsonb, ${'EUR'}, ${1000}, ${'{}'}::jsonb, ${200}, ${1200})
    `;
    const ordA = await order(A, 'FR2026-CIA');
    const ins = (tenant: string, orderId: string, corrects: string) => client`
      insert into invoices (id, tenant_id, order_id, type, series, invoice_number, issued_at, seller_snapshot, buyer_snapshot, currency, subtotal_amount, tax_breakdown, tax_amount, total_amount, corrects_invoice_id)
      values (${newId()}, ${tenant}, ${orderId}, ${'credit_note'}, ${'FR2026'}, ${'2'}, ${client`now()`}, ${'{}'}::jsonb, ${'{}'}::jsonb, ${'EUR'}, ${1000}, ${'{}'}::jsonb, ${200}, ${1200}, ${corrects})
    `;
    await expectFkViolation(ins(A, ordA, invB)); // original invoice belongs to B
    // same-tenant original → OK
    const invA = newId();
    await client`
      insert into invoices (id, tenant_id, order_id, series, invoice_number, issued_at, seller_snapshot, buyer_snapshot, currency, subtotal_amount, tax_breakdown, tax_amount, total_amount)
      values (${invA}, ${A}, ${ordA}, ${'FR2026'}, ${'1'}, ${client`now()`}, ${'{}'}::jsonb, ${'{}'}::jsonb, ${'EUR'}, ${1000}, ${'{}'}::jsonb, ${200}, ${1200})
    `;
    await expect(ins(A, ordA, invA)).resolves.toBeDefined();
  });

  // ===========================================================================
  // 4. Money: integer columns, currency char(3), non-negative CHECKs
  // ===========================================================================
  it('money columns are integer (orders.total_amount, order_items.unit_price_amount, payments.amount)', async () => {
    const cols = await client<{ table_name: string; column_name: string; data_type: string }[]>`
      select table_name, column_name, data_type from information_schema.columns
      where (table_name, column_name) in (
        ('orders','total_amount'), ('order_items','unit_price_amount'), ('payments','amount'),
        ('refunds','amount'), ('cart_items','unit_price_amount'), ('shipping_rates','amount')
      )
    `;
    for (const c of cols) expect(c.data_type).toBe('integer');
    expect(cols.length).toBe(6);
  });

  it('order_items.tax_rate is NUMERIC(5,4) NOT NULL (DGFIP snapshot)', async () => {
    const cols = await client<
      { data_type: string; numeric_precision: number; numeric_scale: number; is_nullable: string }[]
    >`
      select data_type, numeric_precision, numeric_scale, is_nullable
      from information_schema.columns
      where table_name = 'order_items' and column_name = 'tax_rate'
    `;
    expect(cols[0].data_type).toBe('numeric');
    expect(cols[0].numeric_precision).toBe(5);
    expect(cols[0].numeric_scale).toBe(4);
    expect(cols[0].is_nullable).toBe('NO');
  });

  it('currency char_length=3 CHECK rejects 2- and 4-char codes; accepts 3 (orders)', async () => {
    const ins = (cur: string, num: string) => client`
      insert into orders (id, tenant_id, order_number, email, currency, subtotal_amount, total_amount, tax_inclusive, shipping_address, billing_address)
      values (${newId()}, ${A}, ${num}, ${'o@x.test'}, ${cur}, ${1000}, ${1200}, ${true}, ${'{}'}::jsonb, ${'{}'}::jsonb)
    `;
    await expectCheckViolation(ins('EU', 'FR-2'));
    await expectCheckViolation(ins('EURO', 'FR-4'));
    await expect(ins('EUR', 'FR-3')).resolves.toBeDefined();
  });

  it('non-negative money CHECK rejects negative amounts (payments.amount, cart_items)', async () => {
    const ordA = await order(A, 'FR2026-NEG');
    await expectCheckViolation(client`
      insert into payments (id, tenant_id, order_id, provider, amount, currency)
      values (${newId()}, ${A}, ${ordA}, ${'manual'}, ${-1}, ${'EUR'})
    `);
    const cartA = await cart(A);
    const prodA = await product(A, 'neg-prod');
    const varA = await variant(A, prodA, 'NEG-SKU');
    await expectCheckViolation(client`
      insert into cart_items (id, tenant_id, cart_id, variant_id, quantity, unit_price_amount, currency)
      values (${newId()}, ${A}, ${cartA}, ${varA}, ${1}, ${-5}, ${'EUR'})
    `);
  });

  it('non-negative money CHECK rejects a negative orders.total_amount', async () => {
    await expectCheckViolation(client`
      insert into orders (id, tenant_id, order_number, email, currency, subtotal_amount, total_amount, tax_inclusive, shipping_address, billing_address)
      values (${newId()}, ${A}, ${'FR2026-NEGTOT'}, ${'o@x.test'}, ${'EUR'}, ${1000}, ${-1200}, ${true}, ${'{}'}::jsonb, ${'{}'}::jsonb)
    `);
  });

  it('non-negative money CHECK rejects a negative order_items.line_total_amount', async () => {
    const ordA = await order(A, 'FR2026-NEGOI');
    await expectCheckViolation(client`
      insert into order_items (id, tenant_id, order_id, variant_id, product_title, sku, quantity, unit_price_amount, tax_rate, tax_amount, line_total_amount)
      values (${newId()}, ${A}, ${ordA}, ${null}, ${'T'}, ${'S'}, ${1}, ${1000}, ${'0.2000'}, ${200}, ${-2400})
    `);
  });

  it('tax_rates.country char_length=2 CHECK rejects a 3-char country', async () => {
    const ins = (country: string) => client`
      insert into tax_rates (id, tenant_id, country, rate, name)
      values (${newId()}, ${A}, ${country}, ${'0.2000'}, ${'TVA'})
    `;
    await expectCheckViolation(ins('FRA'));
    await expect(ins('FR')).resolves.toBeDefined();
  });

  // ===========================================================================
  // 5. Enums reject invalid values
  // ===========================================================================
  it('orders.status rejects a bogus enum value', async () => {
    await expectEnumViolation(
      client.unsafe(`
      insert into orders (id, tenant_id, order_number, email, status, currency, subtotal_amount, total_amount, tax_inclusive, shipping_address, billing_address)
      values ('${newId()}', '${A}', 'FR-BOGUS', 'o@x.test', 'bogus', 'EUR', 1000, 1200, true, '{}'::jsonb, '{}'::jsonb)
    `),
    );
  });

  it('payments.status rejects a bogus enum value', async () => {
    const ordA = await order(A, 'FR2026-PBOG');
    await expectEnumViolation(
      client.unsafe(`
      insert into payments (id, tenant_id, order_id, provider, amount, currency, status)
      values ('${newId()}', '${A}', '${ordA}', 'manual', 1200, 'EUR', 'not_a_status')
    `),
    );
  });

  // ===========================================================================
  // 6. Numbering: order_number MAY gap (unique per tenant) vs invoice gapless
  // ===========================================================================
  it('orders UNIQUE(tenant_id, order_number) exists and allows gaps (re-use across tenants)', async () => {
    await order(A, 'FR2026-0001');
    // gap to 0003 — perfectly legal for orders
    await expect(order(A, 'FR2026-0003')).resolves.toBeDefined();
    // same number in a different tenant is fine (uniqueness is per-tenant)
    await expect(order(B, 'FR2026-0001')).resolves.toBeDefined();
    // duplicate within the same tenant is rejected (unique violation 23505)
    await expect(order(A, 'FR2026-0001')).rejects.toMatchObject({ code: '23505' });
  });

  it('invoices UNIQUE(tenant_id, series, invoice_number) exists (gapless allocation is enforced here)', async () => {
    const ordA = await order(A, 'FR2026-INV1');
    const ins = (num: string) => client`
      insert into invoices (id, tenant_id, order_id, series, invoice_number, issued_at, seller_snapshot, buyer_snapshot, currency, subtotal_amount, tax_breakdown, tax_amount, total_amount)
      values (${newId()}, ${A}, ${ordA}, ${'FR2026'}, ${num}, ${client`now()`}, ${'{}'}::jsonb, ${'{}'}::jsonb, ${'EUR'}, ${1000}, ${'{}'}::jsonb, ${200}, ${1200})
    `;
    await expect(ins('1')).resolves.toBeDefined();
    // duplicate (tenant, series, number) rejected — the constraint the gapless allocator relies on
    await expect(ins('1')).rejects.toMatchObject({ code: '23505' });
  });
});
