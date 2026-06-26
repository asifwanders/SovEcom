/**
 * Seed-config hardening (Workstream A, finding #1) — defense-in-depth around the destructive
 * admin-credential mutations in the opt-in E2E fixture.
 *
 * The fixture deliberately overwrites the seeded admin's password_hash with a repo-PUBLIC plaintext
 * ('E2e-Admin-2026') and flips `system_state.installed=true`, so the admin SPA is usable in CI without
 * driving the setup wizard. The standalone `pnpm seed` script bypasses `env.validation.ts`, so without
 * an in-function guard there is NO production safety net. These tests pin two invariants:
 *
 *   (i)  seedE2eFixture THROWS when NODE_ENV==='production' (abort loudly — never silently clobber a
 *        real install's admin credential or installed flag, even if SEED_E2E_FIXTURE=1 is set), and
 *   (ii) outside production, the admin password_hash is NOT overwritten and installed is NOT flipped
 *        when a REAL (non-placeholder) admin credential already exists — the mutation is fail-safe and
 *        only runs on a genuinely fresh store (installed=false AND hash===PLACEHOLDER_PASSWORD_HASH).
 *
 * No real Postgres: `db` is a thin in-memory mock of the Drizzle surface the seeder uses (`insert`,
 * `execute`). `insert(...)` returns a chainable stub; `execute(sql)` inspects the SQL text to answer
 * the existence-guards (so the seeder reaches the admin-mutation branch) and records every mutating
 * UPDATE so the assertions can prove which ran.
 */
import { seedE2eFixture, PLACEHOLDER_PASSWORD_HASH, E2E_ADMIN_EMAIL } from './seed-e2e-fixture';

/** A chainable insert stub: `.insert(...).values(...).onConflictDoNothing(...).returning(...)`. */
function insertStub() {
  const chain: Record<string, unknown> = {};
  const ret = () => Promise.resolve([{ id: '00000000-0000-0000-0000-000000000001' }]);
  chain.values = () => chain;
  chain.onConflictDoNothing = () => chain;
  chain.returning = ret;
  // Some inserts (.values().returning()) and some (.values()) — make `values` thenable too so a
  // bare `await db.insert(...).values(...)` resolves without erroring.
  (chain.values as unknown as { then?: unknown }) = (() => chain) as never;
  return chain;
}

/**
 * Build a mock SeedDb. `installedValue` / `adminHash` drive the existence-guard answers so the seeder
 * believes a specific store state. Every `update ... ` SQL is captured into `updates`.
 */
function makeDb(opts: { installedValue: boolean; adminHash: string }) {
  const updates: string[] = [];
  const db = {
    insert: () => insertStub(),
    execute: (query: unknown) => {
      // drizzle's `sql` template exposes static SQL fragments under `queryChunks` (each a
      // `{ value: string[] }`); params are plain values between them. Join the static parts to
      // reconstruct the matchable SQL text.
      const chunks = (query as { queryChunks?: Array<{ value?: unknown }> }).queryChunks ?? [];
      const text = chunks
        .map((c) => {
          const v = c?.value;
          return Array.isArray(v) ? v.join('') : '';
        })
        .join(' ');
      if (/update\s+users\s+set\s+password_hash/i.test(text)) {
        updates.push('update-admin-password');
        return Promise.resolve([]);
      }
      if (/update\s+system_state\s+set\s+value/i.test(text)) {
        updates.push('update-installed');
        return Promise.resolve([]);
      }
      // Existence-guard SELECTs. Resolve the in-stock variant id (so fulfilment/account lines link),
      // the installed flag, and the admin hash; everything else → "absent" so inserts proceed.
      if (/from\s+product_variants/i.test(text)) {
        return Promise.resolve([{ id: '00000000-0000-0000-0000-0000000000aa' }]);
      }
      if (/from\s+system_state/i.test(text)) {
        return Promise.resolve([{ value: opts.installedValue }]);
      }
      if (/from\s+users/i.test(text)) {
        return Promise.resolve([{ password_hash: opts.adminHash }]);
      }
      return Promise.resolve([]);
    },
  };
  return { db: db as never, updates };
}

describe('seedE2eFixture — production + clobber guards (finding #1)', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('THROWS when NODE_ENV==="production" (never runs on a real install, even with SEED_E2E_FIXTURE=1)', async () => {
    process.env.NODE_ENV = 'production';
    const { db } = makeDb({ installedValue: false, adminHash: PLACEHOLDER_PASSWORD_HASH });
    await expect(seedE2eFixture(db, '00000000-0000-0000-0000-0000000000ff')).rejects.toThrow(
      /production/i,
    );
  });

  it('does NOT overwrite the admin password when a real (non-placeholder) credential already exists', async () => {
    process.env.NODE_ENV = 'test';
    const realHash = '$argon2id$v=19$m=65536,t=3,p=4$cmVhbHNhbHQ$cmVhbC1hZG1pbi1jcmVk';
    const { db, updates } = makeDb({ installedValue: true, adminHash: realHash });

    await seedE2eFixture(db, '00000000-0000-0000-0000-0000000000ff');

    expect(updates).not.toContain('update-admin-password');
    expect(updates).not.toContain('update-installed');
  });

  it('DOES set the admin password + installed on a genuinely fresh store (placeholder hash, installed=false)', async () => {
    process.env.NODE_ENV = 'test';
    const { db, updates } = makeDb({
      installedValue: false,
      adminHash: PLACEHOLDER_PASSWORD_HASH,
    });

    await seedE2eFixture(db, '00000000-0000-0000-0000-0000000000ff');

    expect(updates).toContain('update-admin-password');
    expect(updates).toContain('update-installed');
  });

  it('exports a placeholder sentinel + admin email that mirror the seed baseline', () => {
    expect(PLACEHOLDER_PASSWORD_HASH).toMatch(/^\$argon2id\$/);
    expect(E2E_ADMIN_EMAIL).toBe('admin@default.local');
  });
});
