import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  index,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { userRoleEnum } from './_enums';

/**
 * Admin / operator accounts.
 *
 * `password_hash` is Argon2id — a CHECK pins the `$argon2id$` prefix so a
 * bcrypt/plaintext value can never be stored. `totp_secret` holds AEAD ciphertext
 * (encrypted app-side), never a plaintext secret. Parent of `refresh_tokens`, so it
 * declares `UNIQUE(id, tenant_id)` to anchor the composite tenant-isolation FK.
 *
 * `token_version` bumps to invalidate every
 * outstanding access token (guard rejects `tv < token_version`); `totp_secret_pending`
 * holds the AEAD secret during enroll→confirm (inactive until confirmed) with
 * `totp_enroll_started_at` for TTL; a CHECK keeps the active state consistent —
 * `totp_enabled` can only be true once `totp_secret` is set.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: userRoleEnum('role').notNull().default('admin'),
    totpSecret: text('totp_secret'),
    totpSecretPending: text('totp_secret_pending'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    totpEnrollStartedAt: timestamp('totp_enroll_started_at', { withTimezone: true }),
    tokenVersion: integer('token_version').notNull().default(0),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idTenantUq: unique('users_id_tenant_uq').on(t.id, t.tenantId),
    emailUq: unique('users_tenant_email_uq').on(t.tenantId, t.email),
    tenantIdx: index('users_tenant_idx').on(t.tenantId),
    passwordHashChk: check(
      'users_password_hash_argon2id_chk',
      sql`${t.passwordHash} like '$argon2id$%'`,
    ),
    totpConsistencyChk: check(
      'users_totp_consistency_chk',
      sql`${t.totpEnabled} = false OR ${t.totpSecret} IS NOT NULL`,
    ),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
