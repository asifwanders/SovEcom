import { pgTable, uuid, text, timestamp, index, unique, foreignKey } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { users } from './users';

/**
 * Password-reset tokens.
 *
 * `token_hash` is the SHA-256 digest of a 32-byte CSPRNG token (never plaintext) and is
 * globally UNIQUE so a presented reset token resolves to at most one row; single-use is
 * enforced app-side by an atomic `UPDATE … SET consumed_at = now() WHERE token_hash = :h
 * AND consumed_at IS NULL RETURNING …` (the `consumed_at` column is the single-use flag).
 *
 * Admin-only, so the subject is always a `user`. A denormalized NOT-NULL
 * `tenant_id` keeps the row tenant-scoped, and the subject
 * FK is COMPOSITE `(user_id, tenant_id) -> users(id, tenant_id)` (CASCADE) so a token can
 * never straddle tenants — a token for tenant A referencing a B-owned user is rejected at
 * write time, not by app-layer hope.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userFk: foreignKey({
      columns: [t.userId, t.tenantId],
      foreignColumns: [users.id, users.tenantId],
      name: 'password_reset_tokens_user_fk',
    }).onDelete('cascade'),
    tokenHashUq: unique('password_reset_tokens_token_hash_uq').on(t.tokenHash),
    userIdx: index('password_reset_tokens_user_idx').on(t.userId),
    tenantIdx: index('password_reset_tokens_tenant_idx').on(t.tenantId),
    expiresIdx: index('password_reset_tokens_expires_idx').on(t.expiresAt),
  }),
);

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
