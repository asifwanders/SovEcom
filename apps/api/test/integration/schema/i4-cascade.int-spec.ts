/**
 * FK cascade / onDelete behavior.
 *
 *  - DELETE tenant -> CASCADES catalog/identity (users, customers, addresses,
 *    products, variants, images, categories, junctions, tags, bundle_items,
 *    refresh_tokens) BUT `audit_log.tenant_id` is RESTRICT: a tenant with audit
 *    rows cannot be hard-deleted (retention guard).
 *  - DELETE product -> CASCADES variants / images / junctions / bundle_items.
 *  - DELETE variant -> SET NULL on product_images.variant_id (image survives),
 *    CASCADE on bundle_items.
 *  - DELETE category with children -> subtree CASCADES (no RESTRICT abort).
 *
 * RED today: schema + migration absent.
 */
import { connect, migrateUp, truncateAll, makeTenant, newId, Sql, Db } from './_harness';

describe('I4 FK cascade behavior (integration)', () => {
  let client: Sql;
  let db: Db;
  let T: string;

  beforeAll(async () => {
    ({ client, db } = connect());
    await migrateUp(db);
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(client);
    T = await makeTenant(client, `casc-${newId().slice(0, 8)}`);
  });

  const count = async (sql: ReturnType<Sql>): Promise<number> => {
    const rows = (await sql) as { c: string }[];
    return Number(rows[0].c);
  };

  it('DELETE product cascades variants / images / junctions / bundle_items', async () => {
    const productId = newId();
    const variantId = newId();
    const catId = newId();
    const tagId = newId();
    const bundleId = newId();
    await client`insert into products (id, tenant_id, title, slug, status) values (${productId}, ${T}, ${'P'}, ${'p'}, ${'published'})`;
    await client`insert into products (id, tenant_id, title, slug, status) values (${bundleId}, ${T}, ${'B'}, ${'b'}, ${'published'})`;
    await client`insert into product_variants (id, tenant_id, product_id, sku, options, price_amount, currency, stock_quantity) values (${variantId}, ${T}, ${productId}, ${'S'}, ${'{}'}::jsonb, ${100}, ${'EUR'}, ${0})`;
    const imgId = newId();
    await client`insert into images (id, tenant_id, original_key, format, width, height, size_bytes, variants) values (${imgId}, ${T}, ${'k'}, ${'jpeg'}, ${10}, ${10}, ${100}, ${'{}'}::jsonb)`;
    await client`insert into product_images (id, tenant_id, product_id, variant_id, image_id) values (${newId()}, ${T}, ${productId}, ${variantId}, ${imgId})`;
    await client`insert into categories (id, tenant_id, name, slug) values (${catId}, ${T}, ${'C'}, ${'c'})`;
    await client`insert into tags (id, tenant_id, name, slug) values (${tagId}, ${T}, ${'T'}, ${'t'})`;
    await client`insert into product_categories (tenant_id, product_id, category_id) values (${T}, ${productId}, ${catId})`;
    await client`insert into product_tags (tenant_id, product_id, tag_id) values (${T}, ${productId}, ${tagId})`;
    await client`insert into bundle_items (id, tenant_id, bundle_product_id, variant_id, quantity) values (${newId()}, ${T}, ${bundleId}, ${variantId}, ${1})`;

    await client`delete from products where id = ${productId}`;

    expect(
      await count(
        client`select count(*)::int as c from product_variants where product_id = ${productId}`,
      ),
    ).toBe(0);
    expect(
      await count(
        client`select count(*)::int as c from product_images where product_id = ${productId}`,
      ),
    ).toBe(0);
    expect(
      await count(
        client`select count(*)::int as c from product_categories where product_id = ${productId}`,
      ),
    ).toBe(0);
    expect(
      await count(
        client`select count(*)::int as c from product_tags where product_id = ${productId}`,
      ),
    ).toBe(0);
    // bundle item referenced the deleted product's variant -> gone via variant cascade
    expect(
      await count(
        client`select count(*)::int as c from bundle_items where variant_id = ${variantId}`,
      ),
    ).toBe(0);
  });

  it('DELETE variant cascades variant-specific images; product-level images survive', async () => {
    const productId = newId();
    const variantId = newId();
    const variantImageId = newId();
    const productImageId = newId();
    await client`insert into products (id, tenant_id, title, slug, status) values (${productId}, ${T}, ${'P'}, ${'p'}, ${'published'})`;
    await client`insert into product_variants (id, tenant_id, product_id, sku, options, price_amount, currency, stock_quantity) values (${variantId}, ${T}, ${productId}, ${'S'}, ${'{}'}::jsonb, ${100}, ${'EUR'}, ${0})`;
    // a variant-specific image and a product-level image (variant_id NULL)
    const img1 = newId();
    const img2 = newId();
    await client`insert into images (id, tenant_id, original_key, format, width, height, size_bytes, variants) values (${img1}, ${T}, ${'k1'}, ${'jpeg'}, ${10}, ${10}, ${100}, ${'{}'}::jsonb)`;
    await client`insert into images (id, tenant_id, original_key, format, width, height, size_bytes, variants) values (${img2}, ${T}, ${'k2'}, ${'jpeg'}, ${10}, ${10}, ${100}, ${'{}'}::jsonb)`;
    await client`insert into product_images (id, tenant_id, product_id, variant_id, image_id) values (${variantImageId}, ${T}, ${productId}, ${variantId}, ${img1})`;
    await client`insert into product_images (id, tenant_id, product_id, variant_id, image_id) values (${productImageId}, ${T}, ${productId}, ${null}, ${img2})`;

    await client`delete from product_variants where id = ${variantId}`;

    // variant-specific image cascades away; product-level image (variant_id NULL) survives
    expect(
      await count(
        client`select count(*)::int as c from product_images where id = ${variantImageId}`,
      ),
    ).toBe(0);
    expect(
      await count(
        client`select count(*)::int as c from product_images where id = ${productImageId}`,
      ),
    ).toBe(1);
  });

  it('DELETE category with children cascades the subtree (no RESTRICT abort)', async () => {
    const parentId = newId();
    const childId = newId();
    const grandchildId = newId();
    await client`insert into categories (id, tenant_id, name, slug, parent_id) values (${parentId}, ${T}, ${'P'}, ${'parent'}, ${null})`;
    await client`insert into categories (id, tenant_id, name, slug, parent_id) values (${childId}, ${T}, ${'C'}, ${'child'}, ${parentId})`;
    await client`insert into categories (id, tenant_id, name, slug, parent_id) values (${grandchildId}, ${T}, ${'G'}, ${'grandchild'}, ${childId})`;

    await expect(client`delete from categories where id = ${parentId}`).resolves.toBeDefined();
    expect(
      await count(
        client`select count(*)::int as c from categories where id in (${childId}, ${grandchildId})`,
      ),
    ).toBe(0);
  });

  it('DELETE tenant cascades catalog/identity rows', async () => {
    const localTenant = await makeTenant(client, `tear-${newId().slice(0, 8)}`);
    const productId = newId();
    const userId = newId();
    const customerId = newId();
    await client`insert into users (id, tenant_id, email, password_hash, name, role) values (${userId}, ${localTenant}, ${'u@x.test'}, ${'$argon2id$v=19$m=1$a$b'}, ${'U'}, ${'admin'})`;
    await client`insert into customers (id, tenant_id, email, name) values (${customerId}, ${localTenant}, ${'c@x.test'}, ${'C'})`;
    await client`insert into products (id, tenant_id, title, slug, status) values (${productId}, ${localTenant}, ${'P'}, ${'p'}, ${'published'})`;
    await client`insert into refresh_tokens (id, tenant_id, user_id, family_id, token_hash, expires_at) values (${newId()}, ${localTenant}, ${userId}, ${newId()}, ${'h'}, ${client`now() + interval '1 day'`})`;

    await expect(client`delete from tenants where id = ${localTenant}`).resolves.toBeDefined();

    expect(
      await count(client`select count(*)::int as c from users where tenant_id = ${localTenant}`),
    ).toBe(0);
    expect(
      await count(
        client`select count(*)::int as c from customers where tenant_id = ${localTenant}`,
      ),
    ).toBe(0);
    expect(
      await count(client`select count(*)::int as c from products where tenant_id = ${localTenant}`),
    ).toBe(0);
    expect(
      await count(
        client`select count(*)::int as c from refresh_tokens where tenant_id = ${localTenant}`,
      ),
    ).toBe(0);
  });

  it('DELETE tenant with audit_log rows is REJECTED (audit_log.tenant_id RESTRICT — retention)', async () => {
    const localTenant = await makeTenant(client, `aud-${newId().slice(0, 8)}`);
    await client`
      insert into audit_log (id, tenant_id, actor_type, action, resource_type)
      values (${newId()}, ${localTenant}, ${'system'}, ${'create'}, ${'product'})
    `;
    // RESTRICT -> SQLSTATE 23503 foreign_key_violation on the parent delete
    await expect(client`delete from tenants where id = ${localTenant}`).rejects.toMatchObject({
      code: '23503',
    });
    // and the tenant + audit row are still there
    expect(
      await count(client`select count(*)::int as c from tenants where id = ${localTenant}`),
    ).toBe(1);
    expect(
      await count(
        client`select count(*)::int as c from audit_log where tenant_id = ${localTenant}`,
      ),
    ).toBe(1);
  });
});
