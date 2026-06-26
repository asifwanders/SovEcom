/**
 * Migration up + idempotency.
 *
 * Applies `0001` to a clean DB and asserts: all 16 tables exist, the 3 required
 * extensions (pgcrypto, pg_trgm, vector) are installed, and all 5 native enums
 * are registered. Re-running the migrator is a no-op (journal idempotency).
 *
 * RED today: the schema barrel + the `0001` migration do not exist yet.
 */
import { connect, migrateUp, Sql, Db } from './_harness';

const EXPECTED_TABLES = [
  'tenants',
  'users',
  'customers',
  'customer_addresses',
  'products',
  'product_variants',
  'product_images',
  'categories',
  'product_categories',
  'tags',
  'product_tags',
  'bundle_items',
  'refresh_tokens',
  'audit_log',
  'setup_tokens',
  'system_state',
];

const EXPECTED_EXTENSIONS = ['pgcrypto', 'pg_trgm', 'vector'];
const EXPECTED_ENUMS = [
  'tenant_status',
  'user_role',
  'address_type',
  'product_status',
  'actor_type',
];

describe('I1 migration up + idempotency (integration)', () => {
  let client: Sql;
  let db: Db;

  beforeAll(async () => {
    ({ client, db } = connect());
    await migrateUp(db);
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  it('creates all 16 core tables', async () => {
    const rows = await client<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;
    const present = new Set(rows.map((r) => r.table_name));
    for (const t of EXPECTED_TABLES) {
      expect(present.has(t)).toBe(true);
    }
    expect(EXPECTED_TABLES.length).toBe(16);
  });

  it('installs the pgcrypto, pg_trgm and vector extensions', async () => {
    const rows = await client<{ extname: string }[]>`select extname from pg_extension`;
    const present = new Set(rows.map((r) => r.extname));
    for (const ext of EXPECTED_EXTENSIONS) {
      expect(present.has(ext)).toBe(true);
    }
  });

  it('registers all 5 native pg enums', async () => {
    const rows = await client<{ typname: string }[]>`
      select typname from pg_type where typtype = 'e'
    `;
    const present = new Set(rows.map((r) => r.typname));
    for (const e of EXPECTED_ENUMS) {
      expect(present.has(e)).toBe(true);
    }
  });

  it('re-running the migrator is a no-op (idempotent journal)', async () => {
    await expect(migrateUp(db)).resolves.not.toThrow();
    const rows = await client`select to_regclass('public.bundle_items') as t`;
    expect(rows[0].t).toBe('bundle_items');
  });
});
