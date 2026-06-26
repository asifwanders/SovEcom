import { pgTable, uuid, text, timestamp, index, unique, foreignKey } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';
import { customers } from './customers';

/**
 * Email-change verification tokens — the
 * verify-before-switch credential for a customer's self-service email change.
 *
 * Mirrors `password_reset_tokens` exactly with two
 * deliberate differences:
 *   - the subject is the storefront CUSTOMER, so the COMPOSITE FK is
 *     `(customer_id, tenant_id) -> customers(id, tenant_id)` (CASCADE) — a token can
 *     never straddle tenants and is deleted when the customer is hard-deleted; and
 *   - a NOT-NULL `pending_email` column carries the address to switch TO. The swap
 *     happens at CONFIRM time, so the new email lives ONLY on the token row (and on
 *     `customers.pending_email` as a UI mirror) until the link is clicked.
 *
 * `token_hash` is the SHA-256 digest of a 32-byte CSPRNG token (never plaintext) and
 * is globally UNIQUE so a presented token resolves to at most one row; single-use is
 * enforced app-side by an atomic `UPDATE … SET consumed_at = now() WHERE token_hash =
 * :h AND consumed_at IS NULL AND expires_at > now() RETURNING …` (the `consumed_at`
 * column is the single-use flag). The email itself is validated at the DTO — there is
 * no DB CHECK on `pending_email`.
 */
export const emailChangeTokens = pgTable(
  'email_change_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    pendingEmail: text('pending_email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    customerFk: foreignKey({
      columns: [t.customerId, t.tenantId],
      foreignColumns: [customers.id, customers.tenantId],
      name: 'email_change_tokens_customer_fk',
    }).onDelete('cascade'),
    tokenHashUq: unique('email_change_tokens_token_hash_uq').on(t.tokenHash),
    customerIdx: index('email_change_tokens_customer_idx').on(t.customerId),
    tenantIdx: index('email_change_tokens_tenant_idx').on(t.tenantId),
    expiresIdx: index('email_change_tokens_expires_idx').on(t.expiresAt),
  }),
);

export type EmailChangeToken = typeof emailChangeTokens.$inferSelect;
export type NewEmailChangeToken = typeof emailChangeTokens.$inferInsert;
