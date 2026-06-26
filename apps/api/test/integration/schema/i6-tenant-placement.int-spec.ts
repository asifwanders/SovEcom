/**
 * tenant_id placement, verified against the live DB catalog.
 *
 *  - setup_tokens : NO tenant_id (pre-tenant bootstrap)
 *  - system_state : NO tenant_id (global singleton, holds default_tenant_id)
 *  - refresh_tokens: HAS tenant_id NOT NULL (denormalized — S2 fix, Phase-4 RLS)
 *
 * RED today: schema + migration absent.
 */
import { connect, migrateUp, Sql, Db } from './_harness';

describe('I6 tenant_id placement (integration)', () => {
  let client: Sql;
  let db: Db;

  beforeAll(async () => {
    ({ client, db } = connect());
    await migrateUp(db);
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  const hasColumn = async (table: string, column: string): Promise<boolean> => {
    const rows = await client<{ n: string }[]>`
      select column_name as n from information_schema.columns
      where table_schema = 'public' and table_name = ${table} and column_name = ${column}
    `;
    return rows.length === 1;
  };

  it('setup_tokens has NO tenant_id column (deliberate, global bootstrap)', async () => {
    expect(await hasColumn('setup_tokens', 'tenant_id')).toBe(false);
  });

  it('system_state has NO tenant_id column (deliberate, global singleton)', async () => {
    expect(await hasColumn('system_state', 'tenant_id')).toBe(false);
  });

  it('refresh_tokens HAS a NOT NULL tenant_id column (denormalized for RLS)', async () => {
    const rows = await client<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'refresh_tokens' and column_name = 'tenant_id'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe('NO');
  });

  it('system_state primary key is `key` (global K/V), not an id+tenant pair', async () => {
    const rows = await client<{ column_name: string }[]>`
      select kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
      where tc.table_schema = 'public' and tc.table_name = 'system_state'
        and tc.constraint_type = 'PRIMARY KEY'
    `;
    expect(rows.map((r) => r.column_name)).toEqual(['key']);
  });
});
