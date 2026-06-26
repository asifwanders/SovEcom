/**
 * Auth schema integration. SECURITY-CRITICAL.
 *
 * Asserts the migration-0002 invariants against a real Postgres:
 *   - users.token_version defaults to 0.
 *   - users TOTP-consistency CHECK rejects (totp_enabled = true, totp_secret IS NULL),
 *     SQLSTATE 23514; accepts the consistent (enabled + secret) shape.
 *   - refresh_tokens.token_hash is globally UNIQUE (duplicate rejected, 23505) and
 *     family_id is NOT NULL (omitting it is rejected, 23502).
 *   - password_reset_tokens: token_hash UNIQUE (dup rejected); single-use shape
 *     (consumed_at nullable, defaults null, atomic single-use consume); and the
 *     cross-tenant composite-FK rejection — a reset token for tenant A referencing a
 *     B-owned user is an FK violation (23503), not an app-layer hope.
 *
 * RED today: migration 0002 (the new columns / table / constraints) does not exist yet,
 * so migrateUp produces a schema without these and every assertion fails.
 */
import { connect, migrateUp, truncateAll, makeTenant, newId, Sql, Db } from './_harness';

const ARGON = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';

async function expectSqlState(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ code });
}

describe('I8 auth schema delta — SECURITY-CRITICAL (integration)', () => {
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
    A = await makeTenant(client, `auth-a-${newId().slice(0, 8)}`);
    B = await makeTenant(client, `auth-b-${newId().slice(0, 8)}`);
  });

  // ---- fixture builders ----
  async function user(tenant: string, email = `u-${newId().slice(0, 8)}@x.test`): Promise<string> {
    const id = newId();
    await client`
      insert into users (id, tenant_id, email, password_hash, name, role)
      values (${id}, ${tenant}, ${email}, ${ARGON}, ${'U'}, ${'admin'})
    `;
    return id;
  }

  // ---------------------------------------------------------------------------
  // users.token_version
  // ---------------------------------------------------------------------------
  it('users.token_version defaults to 0', async () => {
    const id = await user(A);
    const rows = await client<{ token_version: number }[]>`
      select token_version from users where id = ${id}
    `;
    expect(rows[0].token_version).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // users TOTP-consistency CHECK
  // ---------------------------------------------------------------------------
  it('users_totp_consistency_chk — rejects totp_enabled = true with totp_secret NULL', async () => {
    await expectSqlState(
      client`
        insert into users (id, tenant_id, email, password_hash, name, role, totp_enabled, totp_secret)
        values (${newId()}, ${A}, ${'enabled-nosecret@x.test'}, ${ARGON}, ${'U'}, ${'admin'}, ${true}, ${null})
      `,
      '23514',
    );
  });

  it('users_totp_consistency_chk — accepts totp_enabled = true with a totp_secret set', async () => {
    await expect(
      client`
        insert into users (id, tenant_id, email, password_hash, name, role, totp_enabled, totp_secret)
        values (${newId()}, ${A}, ${'enabled-ok@x.test'}, ${ARGON}, ${'U'}, ${'admin'}, ${true}, ${'AEAD-CIPHERTEXT'})
      `,
    ).resolves.toBeDefined();
  });

  it('users_totp_consistency_chk — accepts totp_enabled = false with a NULL secret (default state)', async () => {
    await expect(
      client`
        insert into users (id, tenant_id, email, password_hash, name, role, totp_enabled, totp_secret)
        values (${newId()}, ${A}, ${'disabled-nosecret@x.test'}, ${ARGON}, ${'U'}, ${'admin'}, ${false}, ${null})
      `,
    ).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // refresh_tokens.token_hash UNIQUE + family_id NOT NULL
  // ---------------------------------------------------------------------------
  it('refresh_tokens.token_hash — duplicate hash is rejected (UNIQUE, 23505)', async () => {
    const u = await user(A);
    const ins = (hash: string) => client`
      insert into refresh_tokens (id, tenant_id, user_id, family_id, token_hash, expires_at)
      values (${newId()}, ${A}, ${u}, ${newId()}, ${hash}, ${client`now() + interval '1 day'`})
    `;
    await expect(ins('dup-hash')).resolves.toBeDefined();
    await expectSqlState(ins('dup-hash'), '23505');
  });

  it('refresh_tokens.family_id — NOT NULL (omitting it is rejected, 23502)', async () => {
    const u = await user(A);
    await expectSqlState(
      client`
        insert into refresh_tokens (id, tenant_id, user_id, family_id, token_hash, expires_at)
        values (${newId()}, ${A}, ${u}, ${null}, ${'h-nofam'}, ${client`now() + interval '1 day'`})
      `,
      '23502',
    );
  });

  // ---------------------------------------------------------------------------
  // password_reset_tokens
  // ---------------------------------------------------------------------------
  const insReset = (
    tenant: string,
    userId: string,
    hash: string,
    expires = client`now() + interval '1 hour'`,
  ) =>
    client`
      insert into password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at)
      values (${newId()}, ${tenant}, ${userId}, ${hash}, ${expires})
    `;

  it('password_reset_tokens.token_hash — duplicate hash is rejected (UNIQUE, 23505)', async () => {
    const u = await user(A);
    await expect(insReset(A, u, 'reset-dup')).resolves.toBeDefined();
    await expectSqlState(insReset(A, u, 'reset-dup'), '23505');
  });

  it('password_reset_tokens — single-use shape: consumed_at nullable, defaults null, atomic consume', async () => {
    const u = await user(A);
    await insReset(A, u, 'reset-single');

    const fresh = await client<{ consumed_at: Date | null }[]>`
      select consumed_at from password_reset_tokens where token_hash = ${'reset-single'}
    `;
    expect(fresh[0].consumed_at).toBeNull();

    // Atomic single-use consume: first claim wins (1 row), replay claims 0 rows.
    const first = await client`
      update password_reset_tokens set consumed_at = now()
      where token_hash = ${'reset-single'} and consumed_at is null
      returning id
    `;
    expect(first.count).toBe(1);

    const replay = await client`
      update password_reset_tokens set consumed_at = now()
      where token_hash = ${'reset-single'} and consumed_at is null
      returning id
    `;
    expect(replay.count).toBe(0);
  });

  it('password_reset_tokens composite-FK — token(tenant=A) referencing a B-owned user is REJECTED (23503); same tenant OK', async () => {
    const userB = await user(B, 'victim@x.test');
    // token scoped to tenant A but pointing at a user owned by B -> cross-tenant FK fails
    await expectSqlState(insReset(A, userB, 'cross-tenant'), '23503');

    const userA = await user(A, 'owner@x.test');
    await expect(insReset(A, userA, 'same-tenant')).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // customers TOTP-consistency CHECK
  // ---------------------------------------------------------------------------
  const insCustomer = (
    tenant: string,
    email: string,
    totpEnabled: boolean,
    totpSecret: string | null,
  ) =>
    client`
      insert into customers (id, tenant_id, email, totp_enabled, totp_secret)
      values (${newId()}, ${tenant}, ${email}, ${totpEnabled}, ${totpSecret})
    `;

  it('customers_totp_consistency_chk — rejects totp_enabled = true with totp_secret NULL (23514)', async () => {
    await expectSqlState(insCustomer(A, 'cust-enabled-nosecret@x.test', true, null), '23514');
  });

  it('customers_totp_consistency_chk — accepts totp_enabled = true with a totp_secret set', async () => {
    await expect(
      insCustomer(A, 'cust-enabled-ok@x.test', true, 'AEAD-CIPHERTEXT'),
    ).resolves.toBeDefined();
  });

  it('customers_totp_consistency_chk — accepts totp_enabled = false with a NULL secret (default)', async () => {
    await expect(
      insCustomer(A, 'cust-disabled-nosecret@x.test', false, null),
    ).resolves.toBeDefined();
  });
});
