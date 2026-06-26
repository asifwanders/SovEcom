/**
 * Per-table CHECK invariants.
 *
 *  - refresh_tokens XOR: CHECK ((user_id IS NOT NULL) <> (customer_id IS NOT NULL))
 *      -> reject both-null AND both-set; accept exactly one set.
 *  - users.password_hash: CHECK (password_hash LIKE '$argon2id$%') -> reject non-Argon2id.
 *  - currency char(3): CHECK length = 3 -> reject 2- or 4-char.
 *  - customer_addresses.country char(2): CHECK length = 2 -> reject wrong length.
 *  - customers anonymized invariant: CHECK (anonymized_at IS NULL OR
 *      (email LIKE 'anonymized-%@deleted.local' AND name IS NULL AND phone IS NULL))
 *      -> reject anonymized row that still carries real PII.
 *
 * A CHECK violation surfaces as SQLSTATE 23514.
 * RED today: schema + migration absent.
 */
import { connect, migrateUp, truncateAll, makeTenant, newId, Sql, Db } from './_harness';

async function expectCheckViolation(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: '23514' });
}

describe('I5 CHECK invariants (integration)', () => {
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
    T = await makeTenant(client, `chk-${newId().slice(0, 8)}`);
  });

  async function user(): Promise<string> {
    const id = newId();
    await client`insert into users (id, tenant_id, email, password_hash, name, role) values (${id}, ${T}, ${`u-${id.slice(0, 8)}@x.test`}, ${'$argon2id$v=19$m=1$a$b'}, ${'U'}, ${'admin'})`;
    return id;
  }
  async function customerRow(): Promise<string> {
    const id = newId();
    await client`insert into customers (id, tenant_id, email, name) values (${id}, ${T}, ${`c-${id.slice(0, 8)}@x.test`}, ${'C'})`;
    return id;
  }

  it('refresh_tokens XOR — rejects both subjects NULL', async () => {
    await expectCheckViolation(client`
      insert into refresh_tokens (id, tenant_id, user_id, customer_id, family_id, token_hash, expires_at)
      values (${newId()}, ${T}, ${null}, ${null}, ${newId()}, ${'h'}, ${client`now() + interval '1 day'`})
    `);
  });

  it('refresh_tokens XOR — rejects both subjects SET', async () => {
    const u = await user();
    const c = await customerRow();
    await expectCheckViolation(client`
      insert into refresh_tokens (id, tenant_id, user_id, customer_id, family_id, token_hash, expires_at)
      values (${newId()}, ${T}, ${u}, ${c}, ${newId()}, ${'h'}, ${client`now() + interval '1 day'`})
    `);
  });

  it('refresh_tokens XOR — accepts exactly one subject (user only)', async () => {
    const u = await user();
    await expect(client`
      insert into refresh_tokens (id, tenant_id, user_id, customer_id, family_id, token_hash, expires_at)
      values (${newId()}, ${T}, ${u}, ${null}, ${newId()}, ${'h'}, ${client`now() + interval '1 day'`})
    `).resolves.toBeDefined();
  });

  it("users.password_hash — rejects a hash not starting with '$argon2id$'", async () => {
    await expectCheckViolation(client`
      insert into users (id, tenant_id, email, password_hash, name, role)
      values (${newId()}, ${T}, ${'bad@x.test'}, ${'$2b$10$bcryptstylehashnotargon'}, ${'U'}, ${'admin'})
    `);
  });

  it("users.password_hash — accepts an '$argon2id$' value", async () => {
    await expect(client`
      insert into users (id, tenant_id, email, password_hash, name, role)
      values (${newId()}, ${T}, ${'ok@x.test'}, ${'$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'}, ${'U'}, ${'admin'})
    `).resolves.toBeDefined();
  });

  it('product_variants.currency — rejects 2- and 4-char currency codes (length = 3)', async () => {
    const productId = newId();
    await client`insert into products (id, tenant_id, title, slug, status) values (${productId}, ${T}, ${'P'}, ${'p'}, ${'published'})`;
    const ins = (cur: string, sku: string) => client`
      insert into product_variants (id, tenant_id, product_id, sku, options, price_amount, currency, stock_quantity)
      values (${newId()}, ${T}, ${productId}, ${sku}, ${'{}'}::jsonb, ${100}, ${cur}, ${0})
    `;
    await expectCheckViolation(ins('EU', 'S-2'));
    await expectCheckViolation(ins('EURO', 'S-4'));
    await expect(ins('EUR', 'S-3')).resolves.toBeDefined();
  });

  it('customer_addresses.country — rejects non-2-char country codes (length = 2)', async () => {
    const c = await customerRow();
    const ins = (country: string) => client`
      insert into customer_addresses (id, tenant_id, customer_id, type, name, line1, city, postal_code, country)
      values (${newId()}, ${T}, ${c}, ${'shipping'}, ${'N'}, ${'L1'}, ${'City'}, ${'00000'}, ${country})
    `;
    await expectCheckViolation(ins('FRA'));
    await expect(ins('FR')).resolves.toBeDefined();
  });

  it('customers anonymized invariant — rejects an anonymized row that still has real PII', async () => {
    await expectCheckViolation(client`
      insert into customers (id, tenant_id, email, name, phone, anonymized_at)
      values (${newId()}, ${T}, ${'still-real@example.test'}, ${'Real Name'}, ${'+33123456789'}, ${client`now()`})
    `);
  });

  it('customers anonymized invariant — accepts a properly scrubbed anonymized row', async () => {
    await expect(client`
      insert into customers (id, tenant_id, email, name, phone, anonymized_at, deleted_at)
      values (${newId()}, ${T}, ${`anonymized-${newId().slice(0, 8)}@deleted.local`}, ${null}, ${null}, ${client`now()`}, ${client`now()`})
    `).resolves.toBeDefined();
  });

  it('setup_tokens — used_at is nullable (single-use tracked by app) and rows insert without it', async () => {
    await expect(client`
      insert into setup_tokens (id, token_hash, expires_at)
      values (${newId()}, ${'$argon2id$v=19$m=1$a$b'}, ${client`now() + interval '24 hours'`})
    `).resolves.toBeDefined();
    // confirm used_at column exists and defaults to null
    const rows = await client<{ used_at: Date | null }[]>`select used_at from setup_tokens limit 1`;
    expect(rows[0].used_at).toBeNull();
  });
});
