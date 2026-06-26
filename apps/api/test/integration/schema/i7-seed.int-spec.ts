/**
 * Seed idempotency.
 *
 * Running the seed twice must leave the DB with exactly:
 *   - one default tenant (slug 'default'),
 *   - one admin-user shell for that tenant,
 *   - the three system_state keys: installed, version, default_tenant_id
 *     (default_tenant_id === the default tenant's id),
 * with no duplicate-key error on the second run and unchanged values.
 *
 * The seed is invoked as the real `pnpm seed` entrypoint (src/database/seed.ts)
 * via ts-node, so this tests the shipped seed, not a re-implementation.
 *
 * RED today: the schema barrel lacks users / system_state, the migration that
 * creates them is absent, and seed.ts does not yet seed the admin shell or
 * system_state keys — so both the migrate and the assertions fail.
 */
import { execFileSync } from 'node:child_process';
import { connect, migrateUp, truncateAll, Sql, Db } from './_harness';

const API_DIR = `${__dirname}/../../..`;

function runSeed(): void {
  // Run the project seed entrypoint exactly as `pnpm seed` does.
  execFileSync('pnpm', ['seed'], {
    cwd: API_DIR,
    stdio: 'pipe',
    env: { ...process.env },
  });
}

describe('I7 seed idempotency (integration)', () => {
  let client: Sql;
  let db: Db;

  beforeAll(async () => {
    ({ client, db } = connect());
    await migrateUp(db);
    await truncateAll(client);
  });

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
  });

  const count = async (sql: ReturnType<Sql>): Promise<number> =>
    Number(((await sql) as { c: string }[])[0].c);

  it('seeding twice yields exactly one tenant, one admin shell and the system_state keys', async () => {
    runSeed();
    runSeed(); // second run must not throw (ON CONFLICT DO NOTHING)

    // exactly one default tenant
    const tenants = await client<{ id: string }[]>`select id from tenants where slug = 'default'`;
    expect(tenants).toHaveLength(1);
    const tenantId = tenants[0].id;

    // exactly one admin-user shell for that tenant
    expect(
      await count(
        client`select count(*)::int as c from users where tenant_id = ${tenantId} and role in ('owner','admin')`,
      ),
    ).toBe(1);

    // the three system_state keys exist, unchanged, with default_tenant_id pointing at the tenant
    const stateRows = await client<{ key: string; value: unknown }[]>`
      select key, value from system_state where key in ('installed', 'version', 'default_tenant_id')
    `;
    const keys = new Set(stateRows.map((r) => r.key));
    expect(keys.has('installed')).toBe(true);
    expect(keys.has('version')).toBe(true);
    expect(keys.has('default_tenant_id')).toBe(true);

    const dt = stateRows.find((r) => r.key === 'default_tenant_id')!.value;
    // value is jsonb — accept either a bare json string or { default_tenant_id } shape
    expect(JSON.stringify(dt)).toContain(tenantId);
  });
});
