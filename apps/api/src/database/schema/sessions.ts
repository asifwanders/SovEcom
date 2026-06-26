import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { users } from './users';
import { customers } from './customers';

/**
 * Hashed refresh tokens (filename `sessions.ts`, table name `refresh_tokens`). No `updated_at`.
 *
 * `token_hash` is a SHA-256 / HMAC-SHA256 digest of a 64-byte CSPRNG token (never plaintext) and
 * is globally UNIQUE (a presented token resolves to at most one row). Exactly one subject is set —
 * an XOR CHECK rejects both-null and both-set. A denormalized NOT-NULL `tenant_id` keeps the row
 * tenant-scoped, and the subject FKs are COMPOSITE `(user_id, tenant_id) -> users` /
 * `(customer_id, tenant_id) -> customers`, both CASCADE.
 *
 * `family_id` groups every token in one rotation lineage so the
 * atomic reuse-detection UPDATE can revoke the whole family on a replayed/leaked token.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id'),
    customerId: uuid('customer_id'),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userFk: foreignKey({
      columns: [t.userId, t.tenantId],
      foreignColumns: [users.id, users.tenantId],
      name: 'refresh_tokens_user_fk',
    }).onDelete('cascade'),
    customerFk: foreignKey({
      columns: [t.customerId, t.tenantId],
      foreignColumns: [customers.id, customers.tenantId],
      name: 'refresh_tokens_customer_fk',
    }).onDelete('cascade'),
    subjectXorChk: check(
      'refresh_tokens_subject_xor_chk',
      sql`(${t.userId} is not null) <> (${t.customerId} is not null)`,
    ),
    tokenHashUq: unique('refresh_tokens_token_hash_uq').on(t.tokenHash),
    tokenHashIdx: index('refresh_tokens_token_hash_idx').on(t.tokenHash),
    expiresIdx: index('refresh_tokens_expires_idx').on(t.expiresAt),
    userIdx: index('refresh_tokens_user_idx').on(t.userId),
    customerIdx: index('refresh_tokens_customer_idx').on(t.customerId),
    familyIdx: index('refresh_tokens_family_idx').on(t.familyId),
    tenantIdx: index('refresh_tokens_tenant_idx').on(t.tenantId),
  }),
);

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
