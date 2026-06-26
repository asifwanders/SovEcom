import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/**
 * One-time setup tokens (FR-SETUP-001 — anti-default-password).
 *
 * NO `tenant_id` by design — this is a pre-tenant bootstrap table. `token_hash`
 * is a SHA-256 hash (opaque high-entropy token, reset-token convention;
 * never plaintext), `expires_at` is the 24h TTL, single-use is tracked by the
 * nullable `used_at`.
 */
export const setupTokens = pgTable(
  'setup_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    expiresIdx: index('setup_tokens_expires_idx').on(t.expiresAt),
    // verify/consume look up by token_hash equality; index it so repeated
    // not-installed boots can't degrade those reads to a seq scan (review nit).
    tokenHashIdx: index('setup_tokens_token_hash_idx').on(t.tokenHash),
  }),
);

export type SetupToken = typeof setupTokens.$inferSelect;
export type NewSetupToken = typeof setupTokens.$inferInsert;
