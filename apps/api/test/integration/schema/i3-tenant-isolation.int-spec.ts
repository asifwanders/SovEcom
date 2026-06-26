/**
 * Composite-FK tenant isolation. SECURITY-CRITICAL.
 *
 * The headline guarantee: a cross-tenant child reference is a write-time FK
 * violation, NOT an app-layer hope. Every parent carries UNIQUE(id, tenant_id);
 * every child FK is composite (parent_id, tenant_id) -> parent(id, tenant_id).
 *
 * For each composite-FK child we assert BOTH directions:
 *   - tenant_id = A, parent owned by B  -> MUST throw an FK violation (23503)
 *   - tenant_id matches the parent       -> succeeds
 *
 * Children covered: product_variants.product_id, product_images.variant_id,
 * customer_addresses.customer_id, categories.parent_id (self-ref), both
 * junctions (product_categories, product_tags), bundle_items (both FKs).
 *
 * RED today: schema + migration absent (the composite FKs cannot reject what
 * does not exist).
 */
import { connect, migrateUp, truncateAll, makeTenant, newId, Sql, Db } from './_harness';

/** Assert a thrown DB error is specifically a foreign-key violation (SQLSTATE 23503). */
async function expectFkViolation(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: '23503' });
}

describe('I3 composite-FK tenant isolation — SECURITY-CRITICAL (integration)', () => {
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
    A = await makeTenant(client, `iso-a-${newId().slice(0, 8)}`);
    B = await makeTenant(client, `iso-b-${newId().slice(0, 8)}`);
  });

  // ---- fixture builders (each parent is created owned by a specific tenant) ----
  async function product(tenant: string, slug: string): Promise<string> {
    const id = newId();
    await client`insert into products (id, tenant_id, title, slug, status) values (${id}, ${tenant}, ${'P'}, ${slug}, ${'published'})`;
    return id;
  }
  async function variant(tenant: string, productId: string, sku: string): Promise<string> {
    const id = newId();
    await client`
      insert into product_variants (id, tenant_id, product_id, sku, options, price_amount, currency, stock_quantity)
      values (${id}, ${tenant}, ${productId}, ${sku}, ${'{}'}::jsonb, ${1000}, ${'EUR'}, ${0})
    `;
    return id;
  }
  async function customer(tenant: string, email: string): Promise<string> {
    const id = newId();
    await client`insert into customers (id, tenant_id, email, name) values (${id}, ${tenant}, ${email}, ${'C'})`;
    return id;
  }
  async function category(
    tenant: string,
    slug: string,
    parentId: string | null = null,
  ): Promise<string> {
    const id = newId();
    await client`insert into categories (id, tenant_id, name, slug, parent_id) values (${id}, ${tenant}, ${'N'}, ${slug}, ${parentId})`;
    return id;
  }
  async function tag(tenant: string, slug: string): Promise<string> {
    const id = newId();
    await client`insert into tags (id, tenant_id, name, slug) values (${id}, ${tenant}, ${'N'}, ${slug})`;
    return id;
  }

  it('product_variants — variant(tenant=A) referencing product owned by B is REJECTED; same tenant OK', async () => {
    const prodB = await product(B, 'b-prod');
    await expectFkViolation(variant(A, prodB, 'SKU-X')); // cross-tenant
    const prodA = await product(A, 'a-prod');
    await expect(variant(A, prodA, 'SKU-OK')).resolves.toBeDefined(); // matching tenant
  });

  it('product_images.variant_id — image(tenant=A) referencing a B-owned variant is REJECTED; same tenant OK', async () => {
    const prodB = await product(B, 'b-prod');
    const varB = await variant(B, prodB, 'SKU-B');
    const prodA = await product(A, 'a-prod');
    // A tenant-A image row to satisfy the (image_id, tenant_id) composite FK.
    const imgA = newId();
    await client`insert into images (id, tenant_id, original_key, format, width, height, size_bytes, variants) values (${imgA}, ${A}, ${'k'}, ${'jpeg'}, ${10}, ${10}, ${100}, ${'{}'}::jsonb)`;
    // image bound to product A but variant B -> cross-tenant variant FK must fail
    const insImage = (tenant: string, productId: string, variantId: string | null) =>
      client`
        insert into product_images (id, tenant_id, product_id, variant_id, image_id)
        values (${newId()}, ${tenant}, ${productId}, ${variantId}, ${imgA})
      `;
    await expectFkViolation(insImage(A, prodA, varB));
    const varA = await variant(A, prodA, 'SKU-A');
    await expect(insImage(A, prodA, varA)).resolves.toBeDefined();
  });

  it('customer_addresses.customer_id — address(tenant=A) referencing a B-owned customer is REJECTED; same tenant OK', async () => {
    const custB = await customer(B, 'b@example.test');
    const insAddr = (tenant: string, customerId: string) =>
      client`
        insert into customer_addresses (id, tenant_id, customer_id, type, name, line1, city, postal_code, country)
        values (${newId()}, ${tenant}, ${customerId}, ${'shipping'}, ${'N'}, ${'L1'}, ${'City'}, ${'00000'}, ${'FR'})
      `;
    await expectFkViolation(insAddr(A, custB));
    const custA = await customer(A, 'a@example.test');
    await expect(insAddr(A, custA)).resolves.toBeDefined();
  });

  it('categories.parent_id (self-ref) — child(tenant=A) pointing at a B-owned parent is REJECTED; same tenant OK', async () => {
    const parentB = await category(B, 'b-parent');
    await expectFkViolation(category(A, 'a-child', parentB)); // cross-tenant self-FK
    const parentA = await category(A, 'a-parent');
    await expect(category(A, 'a-child', parentA)).resolves.toBeDefined();
  });

  it('product_categories junction — straddling tenants on either FK is REJECTED; same tenant OK', async () => {
    const prodA = await product(A, 'pc-a-prod');
    const catA = await category(A, 'pc-a-cat');
    const prodB = await product(B, 'pc-b-prod');
    const catB = await category(B, 'pc-b-cat');
    const link = (tenant: string, productId: string, categoryId: string) =>
      client`insert into product_categories (tenant_id, product_id, category_id) values (${tenant}, ${productId}, ${categoryId})`;
    await expectFkViolation(link(A, prodB, catA)); // product belongs to B
    await expectFkViolation(link(A, prodA, catB)); // category belongs to B
    await expect(link(A, prodA, catA)).resolves.toBeDefined(); // all A
  });

  it('product_tags junction — straddling tenants on either FK is REJECTED; same tenant OK', async () => {
    const prodA = await product(A, 'pt-a-prod');
    const tagA = await tag(A, 'pt-a-tag');
    const prodB = await product(B, 'pt-b-prod');
    const tagB = await tag(B, 'pt-b-tag');
    const link = (tenant: string, productId: string, tagId: string) =>
      client`insert into product_tags (tenant_id, product_id, tag_id) values (${tenant}, ${productId}, ${tagId})`;
    await expectFkViolation(link(A, prodB, tagA));
    await expectFkViolation(link(A, prodA, tagB));
    await expect(link(A, prodA, tagA)).resolves.toBeDefined();
  });

  it('bundle_items — both composite FKs reject cross-tenant; same tenant OK', async () => {
    const bundleA = await product(A, 'bundle-a');
    const compA = await product(A, 'comp-a');
    const varA = await variant(A, compA, 'BV-A');
    const bundleB = await product(B, 'bundle-b');
    const compB = await product(B, 'comp-b');
    const varB = await variant(B, compB, 'BV-B');

    const insItem = (tenant: string, bundleProductId: string, variantId: string) =>
      client`
        insert into bundle_items (id, tenant_id, bundle_product_id, variant_id, quantity)
        values (${newId()}, ${tenant}, ${bundleProductId}, ${variantId}, ${1})
      `;
    await expectFkViolation(insItem(A, bundleB, varA)); // bundle product belongs to B
    await expectFkViolation(insItem(A, bundleA, varB)); // variant belongs to B
    await expect(insItem(A, bundleA, varA)).resolves.toBeDefined(); // all A
  });
});
