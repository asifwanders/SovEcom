/**
 * TokenRetentionSweeperService (integration).
 *
 * Seeds OLD (past the retention grace) + FRESH (within grace) rows in all three token
 * tables — `email_change_tokens`, `password_reset_tokens`, `customer_password_reset_tokens`
 * — then drives `sweep()` directly and asserts ONLY the stale rows are deleted. The
 * predicate is purely expiry-based (`expires_at < now() - grace`), so a CONSUMED-but-recent
 * row survives and an EXPIRED-long-ago row is reclaimed regardless of `consumed_at`.
 *
 * Uses SELECT-guard seeds (not ON CONFLICT) because the customer email has a partial unique
 * index. Tenant + customer + user FKs are satisfied by seeding parents first.
 */
import { uuidv7 } from 'uuidv7';
import { TokenRetentionSweeperService } from '../../../src/customers/auth/token-retention-sweeper.service';
import { DatabaseService } from '../../../src/database/database.service';
import {
  bootCustomersApp,
  teardownCustomersApp,
  resetCustomersState,
  uniqEmail,
  DEFAULT_TENANT_ID,
  CustomersHarness,
} from './_customers-harness';

/** Seed an ACTIVE customer directly (SELECT-guard, partial unique index). Returns the id. */
async function seedCustomer(h: CustomersHarness, email: string): Promise<string> {
  const existing = await h.client<{ id: string }[]>`
    select id from customers where tenant_id = ${DEFAULT_TENANT_ID} and email = ${email}
      and deleted_at is null and anonymized_at is null limit 1`;
  if (existing[0]) return existing[0].id;
  const id = uuidv7();
  await h.client`
    insert into customers (id, tenant_id, email, password_hash, name)
    values (${id}, ${DEFAULT_TENANT_ID}, ${email}, ${null}, ${'Seeded'})`;
  return id;
}

/** Seed a user (admin) directly for password_reset_tokens FK. Returns the id. */
async function seedUser(h: CustomersHarness, email: string): Promise<string> {
  const argon2 = await import('argon2');
  const passwordHash = await argon2.hash('correct horse battery staple', {
    type: argon2.argon2id,
  });
  const id = uuidv7();
  await h.client`
    insert into users (id, tenant_id, email, password_hash, name, role, totp_enabled)
    values (${id}, ${DEFAULT_TENANT_ID}, ${email}, ${passwordHash}, ${'U'}, ${'admin'}, ${false})`;
  return id;
}

/** Insert a customer_password_reset_tokens row with an explicit expiry. */
async function seedCustomerResetToken(
  h: CustomersHarness,
  customerId: string,
  expiresAt: string,
  consumed: boolean,
): Promise<void> {
  await h.client`
    insert into customer_password_reset_tokens (id, tenant_id, customer_id, token_hash, expires_at, consumed_at)
    values (${uuidv7()}, ${DEFAULT_TENANT_ID}, ${customerId}, ${uuidv7().replace(/-/g, '')},
            ${expiresAt}::timestamptz, ${consumed ? new Date().toISOString() : null})`;
}

/** Insert an email_change_tokens row with an explicit expiry. */
async function seedEmailChangeToken(
  h: CustomersHarness,
  customerId: string,
  pendingEmail: string,
  expiresAt: string,
): Promise<void> {
  await h.client`
    insert into email_change_tokens (id, tenant_id, customer_id, token_hash, pending_email, expires_at)
    values (${uuidv7()}, ${DEFAULT_TENANT_ID}, ${customerId}, ${uuidv7().replace(/-/g, '')},
            ${pendingEmail}, ${expiresAt}::timestamptz)`;
}

/** Insert a password_reset_tokens (admin) row with an explicit expiry. */
async function seedAdminResetToken(
  h: CustomersHarness,
  userId: string,
  expiresAt: string,
): Promise<void> {
  await h.client`
    insert into password_reset_tokens (id, tenant_id, user_id, token_hash, expires_at)
    values (${uuidv7()}, ${DEFAULT_TENANT_ID}, ${userId}, ${uuidv7().replace(/-/g, '')},
            ${expiresAt}::timestamptz)`;
}

async function count(h: CustomersHarness, table: string): Promise<number> {
  const rows = await h.client<{ n: string }[]>`
    select count(*)::int as n from ${h.client(table)}`;
  return Number(rows[0]!.n);
}

describe('TokenRetentionSweeperService.sweep (integration, F10)', () => {
  let h: CustomersHarness;
  let sweeper: TokenRetentionSweeperService;

  beforeAll(async () => {
    h = await bootCustomersApp();
  });
  afterAll(async () => {
    await teardownCustomersApp(h);
  });
  beforeEach(async () => {
    await resetCustomersState(h);
    // Direct instantiation against the real DatabaseService (default 7-day grace).
    const db = h.app.get(DatabaseService, { strict: false });
    sweeper = new TokenRetentionSweeperService(db);
  });

  it('deletes ONLY rows expired beyond the 7-day grace, across all three tables', async () => {
    const customerId = await seedCustomer(h, uniqEmail());
    const userId = await seedUser(h, uniqEmail());

    // OLD: expired 10 days ago (> 7-day grace) → must be swept.
    const oldAt = new Date(Date.now() - 10 * 86400_000).toISOString();
    // FRESH: expired 1 hour ago (within the 7-day grace) → must survive.
    const freshAt = new Date(Date.now() - 3600_000).toISOString();

    // customer_password_reset_tokens: one OLD (unconsumed) + one FRESH (consumed — proves
    // the predicate is expiry-based, not consumed_at-based: a recent consumed row survives).
    await seedCustomerResetToken(h, customerId, oldAt, false);
    await seedCustomerResetToken(h, customerId, freshAt, true);

    // email_change_tokens: one OLD + one FRESH.
    await seedEmailChangeToken(h, customerId, uniqEmail(), oldAt);
    await seedEmailChangeToken(h, customerId, uniqEmail(), freshAt);

    // password_reset_tokens (admin): one OLD + one FRESH.
    await seedAdminResetToken(h, userId, oldAt);
    await seedAdminResetToken(h, userId, freshAt);

    expect(await count(h, 'customer_password_reset_tokens')).toBe(2);
    expect(await count(h, 'email_change_tokens')).toBe(2);
    expect(await count(h, 'password_reset_tokens')).toBe(2);

    const deleted = await sweeper.sweep();
    // Exactly the three OLD rows (one per table) are reclaimed.
    expect(deleted).toBe(3);

    // The fresh row in each table survives.
    expect(await count(h, 'customer_password_reset_tokens')).toBe(1);
    expect(await count(h, 'email_change_tokens')).toBe(1);
    expect(await count(h, 'password_reset_tokens')).toBe(1);
  });

  it('is a no-op (returns 0) when no row is past the grace', async () => {
    const customerId = await seedCustomer(h, uniqEmail());
    // A row expired 1 day ago is still WITHIN the 7-day grace → survives.
    await seedCustomerResetToken(
      h,
      customerId,
      new Date(Date.now() - 86400_000).toISOString(),
      false,
    );
    const deleted = await sweeper.sweep();
    expect(deleted).toBe(0);
    expect(await count(h, 'customer_password_reset_tokens')).toBe(1);
  });

  it('honours TOKEN_RETENTION_DAYS (clamped) — a 1-day grace sweeps a 2-day-old row', async () => {
    const prev = process.env.TOKEN_RETENTION_DAYS;
    process.env.TOKEN_RETENTION_DAYS = '1';
    try {
      const db = h.app.get(DatabaseService, { strict: false });
      const oneDay = new TokenRetentionSweeperService(db);
      const customerId = await seedCustomer(h, uniqEmail());
      // Expired 2 days ago → past a 1-day grace → swept.
      await seedCustomerResetToken(
        h,
        customerId,
        new Date(Date.now() - 2 * 86400_000).toISOString(),
        false,
      );
      const deleted = await oneDay.sweep();
      expect(deleted).toBe(1);
      expect(await count(h, 'customer_password_reset_tokens')).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.TOKEN_RETENTION_DAYS;
      else process.env.TOKEN_RETENTION_DAYS = prev;
    }
  });
});
