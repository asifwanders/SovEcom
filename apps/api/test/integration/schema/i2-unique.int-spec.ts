/**
 * Tenant-scoped unique constraints.
 *
 *  - users:       UNIQUE(tenant_id, email)            — same email OK across tenants, dup within tenant rejected
 *  - customers:   partial UNIQUE(tenant_id, email) WHERE deleted_at IS NULL AND anonymized_at IS NULL
 *                 — second *active* dup rejected; multiple soft-deleted / anonymized allowed
 *  - products:    UNIQUE(tenant_id, slug)
 *  - categories:  UNIQUE(tenant_id, slug)
 *  - tags:        UNIQUE(tenant_id, slug)
 *  - variants:    UNIQUE(tenant_id, sku)
 *
 * RED today: schema + migration absent.
 */
import { connect, migrateUp, truncateAll, makeTenant, newId, Sql, Db } from './_harness';

describe('I2 tenant-scoped unique constraints (integration)', () => {
  let client: Sql;
  let db: Db;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    ({ client, db } = connect());
    await migrateUp(db);
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(client);
    tenantA = await makeTenant(client, `a-${Date.now()}`);
    tenantB = await makeTenant(client, `b-${Date.now()}`);
  });

  const insUser = (tenantId: string, email: string) =>
    client`
      insert into users (id, tenant_id, email, password_hash, name, role)
      values (${newId()}, ${tenantId}, ${email}, ${'$argon2id$v=19$m=65536,t=3,p=4$abc$def'}, ${'U'}, ${'admin'})
    `;

  it('users — same email allowed across two tenants, duplicate within a tenant rejected', async () => {
    await insUser(tenantA, 'dup@example.test');
    // same email, different tenant — OK
    await expect(insUser(tenantB, 'dup@example.test')).resolves.toBeDefined();
    // same email, same tenant — rejected
    await expect(insUser(tenantA, 'dup@example.test')).rejects.toThrow();
  });

  const insCustomer = (
    tenantId: string,
    email: string | null,
    opts: { deleted?: boolean; anonymized?: boolean } = {},
  ) =>
    client`
      insert into customers (id, tenant_id, email, name, deleted_at, anonymized_at)
      values (
        ${newId()}, ${tenantId}, ${email}, ${opts.anonymized ? null : 'C'},
        ${opts.deleted ? client`now()` : null},
        ${opts.anonymized ? client`now()` : null}
      )
    `;

  it('customers — same email allowed across two tenants', async () => {
    await insCustomer(tenantA, 'shared@example.test');
    await expect(insCustomer(tenantB, 'shared@example.test')).resolves.toBeDefined();
  });

  it('customers — second ACTIVE row with same email/tenant rejected (partial unique)', async () => {
    await insCustomer(tenantA, 'active@example.test');
    await expect(insCustomer(tenantA, 'active@example.test')).rejects.toThrow();
  });

  it('customers — a soft-deleted/anonymized row does NOT block a new active row (partial unique)', async () => {
    // anonymized row carries the GDPR-scrubbed email pattern (CHECK in I5); use that form
    await insCustomer(tenantA, 'anonymized-1@deleted.local', { anonymized: true });
    // a brand-new active row with a real email is allowed (the partial index ignores the anonymized one)
    await expect(insCustomer(tenantA, 'reuser@example.test')).resolves.toBeDefined();
  });

  it('products / categories / tags — UNIQUE(tenant_id, slug)', async () => {
    const insProduct = (t: string, slug: string) =>
      client`insert into products (id, tenant_id, title, slug, status) values (${newId()}, ${t}, ${'T'}, ${slug}, ${'draft'})`;
    await insProduct(tenantA, 'same-slug');
    await expect(insProduct(tenantB, 'same-slug')).resolves.toBeDefined(); // cross-tenant OK
    await expect(insProduct(tenantA, 'same-slug')).rejects.toThrow(); // within-tenant dup

    const insCategory = (t: string, slug: string) =>
      client`insert into categories (id, tenant_id, name, slug) values (${newId()}, ${t}, ${'N'}, ${slug})`;
    await insCategory(tenantA, 'cat-slug');
    await expect(insCategory(tenantA, 'cat-slug')).rejects.toThrow();

    const insTag = (t: string, slug: string) =>
      client`insert into tags (id, tenant_id, name, slug) values (${newId()}, ${t}, ${'N'}, ${slug})`;
    await insTag(tenantA, 'tag-slug');
    await expect(insTag(tenantA, 'tag-slug')).rejects.toThrow();
  });

  it('product_variants — UNIQUE(tenant_id, sku)', async () => {
    const productId = newId();
    await client`insert into products (id, tenant_id, title, slug, status) values (${productId}, ${tenantA}, ${'P'}, ${'p-1'}, ${'published'})`;
    const insVariant = (t: string, p: string, sku: string) =>
      client`
        insert into product_variants (id, tenant_id, product_id, sku, options, price_amount, currency, stock_quantity)
        values (${newId()}, ${t}, ${p}, ${sku}, ${'{}'}::jsonb, ${1000}, ${'EUR'}, ${0})
      `;
    await insVariant(tenantA, productId, 'SKU-DUP');
    await expect(insVariant(tenantA, productId, 'SKU-DUP')).rejects.toThrow();
  });
});
