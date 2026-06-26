import { pgTable, uuid, text, timestamp, index, unique, foreignKey } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { customers } from './customers';

/**
 * Customer password-reset tokens — the UNAUTH
 * forgot-password credential for a storefront customer's self-service reset.
 *
 * Mirrors `email_change_tokens` exactly but WITHOUT the
 * `pending_email` column: a reset carries NO payload — the token alone authorizes
 * setting a new password, so the only state on the row is the single-use lifecycle
 * (hash, expiry, consumed flag). Two deliberate properties carried over:
 *   - the subject is the storefront CUSTOMER, so the COMPOSITE FK is
 *     `(customer_id, tenant_id) -> customers(id, tenant_id)` (CASCADE) — a token can
 *     never straddle tenants and is deleted when the customer is hard-deleted; and
 *   - a denormalized NOT-NULL `tenant_id` keeps the row tenant-scoped for Phase-4 RLS.
 *
 * `token_hash` is the SHA-256 digest of a 32-byte CSPRNG token (never plaintext) and
 * is globally UNIQUE so a presented token resolves to at most one row; single-use is
 * enforced app-side by an atomic `UPDATE … SET consumed_at = now() WHERE token_hash =
 * :h AND consumed_at IS NULL AND expires_at > now() RETURNING …` (the `consumed_at`
 * column is the single-use flag).
 */
export const customerPasswordResetTokens = pgTable(
  'customer_password_reset_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    customerFk: foreignKey({
      columns: [t.customerId, t.tenantId],
      foreignColumns: [customers.id, customers.tenantId],
      name: 'customer_password_reset_tokens_customer_fk',
    }).onDelete('cascade'),
    tokenHashUq: unique('customer_password_reset_tokens_token_hash_uq').on(t.tokenHash),
    customerIdx: index('customer_password_reset_tokens_customer_idx').on(t.customerId),
    tenantIdx: index('customer_password_reset_tokens_tenant_idx').on(t.tenantId),
    expiresIdx: index('customer_password_reset_tokens_expires_idx').on(t.expiresAt),
  }),
);

export type CustomerPasswordResetToken = typeof customerPasswordResetTokens.$inferSelect;
export type NewCustomerPasswordResetToken = typeof customerPasswordResetTokens.$inferInsert;
