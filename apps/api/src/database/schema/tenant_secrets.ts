import { pgTable, uuid, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * Setup-wizard secrets at rest.
 *
 * Holds the API keys / credential blobs the setup wizard collects (SMTP, Stripe, …),
 * one row per (`tenant_id`, `kind`). `ciphertext` is an {@link AeadService}
 * (AES-256-GCM) blob whose AAD = `tenant_id`, so a row encrypted for one tenant can
 * never be decrypted under another (cross-tenant replay fails closed). There is NO
 * plaintext column: the secret exists ONLY as ciphertext here, is never logged, and
 * is never returned in a response body. `UNIQUE(tenant_id, kind)` makes each kind a
 * single upsertable slot (re-configuring a provider overwrites, never accumulates).
 *
 * The plaintext is always a JSON blob so multi-field credentials (e.g. the full SMTP
 * `{host,port,user,pass,from,secure}`) live under one `kind`.
 */
export const tenantSecrets = pgTable(
  'tenant_secrets',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Logical secret name, e.g. `smtp`, `stripe`. Scopes the upsert slot. */
    kind: text('kind').notNull(),
    /** AES-256-GCM blob (AAD = tenant_id). NEVER plaintext, NEVER logged. */
    ciphertext: text('ciphertext').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantKindUq: unique('tenant_secrets_tenant_kind_uq').on(t.tenantId, t.kind),
  }),
);

export type TenantSecret = typeof tenantSecrets.$inferSelect;
export type NewTenantSecret = typeof tenantSecrets.$inferInsert;
