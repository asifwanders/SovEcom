import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { tenants } from './_tenants';

/**
 * Storefront customers — the ONE soft-delete table.
 *
 * Soft-delete + RGPD erasure: `deleted_at` hides the row; `anonymized_at` marks
 * scrubbed PII. The active-email uniqueness is a PARTIAL unique index gated on both
 * being NULL, so a deleted/anonymized row never blocks a fresh signup. A
 * CHECK enforces the anonymized invariant: once `anonymized_at` is set, the email
 * must match the scrubbed pattern and name/phone must be NULL. Parent of
 * `customer_addresses` and `refresh_tokens`, so it declares `UNIQUE(id, tenant_id)`.
 */
export const customers = pgTable(
  'customers',
  {
    id: uuid('id')
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    passwordHash: text('password_hash'),
    name: text('name'),
    phone: text('phone'),
    isB2b: boolean('is_b2b').notNull().default(false),
    vatNumber: text('vat_number'),
    vatValidated: boolean('vat_validated').notNull().default(false),
    vatValidatedAt: timestamp('vat_validated_at', { withTimezone: true }),
    taxExempt: boolean('tax_exempt').notNull().default(false),
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    acceptsMarketing: boolean('accepts_marketing').notNull().default(false),
    // Preferred locale for transactional emails.
    // NULLABLE with no default — null means "unknown", and the email composer falls
    // back to the default locale ('en'). Fixed-width 2-char code modelled
    // as TEXT + a char_length CHECK (the established idiom; never char(2)), mirroring
    // pages.locale but nullable. The WRITE path (setting this at registration) lands
    // with the deferred storefront customer-auth flow — F only HONORS it when set.
    locale: text('locale'),
    // verify-before-switch email change. While a
    // change is in flight this NULLABLE column mirrors the proposed new address for
    // UI ("pending: …"); the AUTHORITATIVE in-flight state is the unconsumed
    // `email_change_tokens` row. It is set at INITIATE (free target only), cleared at
    // CONFIRM (swapped into `email`) and on RGPD erase. No DB CHECK — the email is
    // validated at the DTO, and this is only a denormalized mirror.
    pendingEmail: text('pending_email'),
    // Customer session-kill. The customer-JWT guards mint the `tv` claim from this value and reject any
    // access token whose `tv !== token_version` (strict equality, fail-closed).
    // IMPORTANT: bumping this kills OUTSTANDING access tokens but NOT the refresh
    // family — a bump alone is defeatable by one refresh round-trip. The future
    // bump-caller (customer password change / forced logout) MUST pair the bump
    // with refresh-family revocation in the same tx.
    tokenVersion: integer('token_version').notNull().default(0),
    // Per-account soft lockout — mirrors the same counter on admin users.
    // The existing IP+email login throttle is defeated by IP rotation; this account-keyed counter is IP-independent.
    // `failed_attempts` bumps on each wrong password and trips `locked_until` (a 15-min
    // soft lock) at the threshold (5). A CORRECT password bypasses/clears the lock so an
    // attacker cannot DoS a victim out of their own valid credential.
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    // Stripe Customer id reused across this customer's payments:
    // created once for a logged-in customer (saved methods / SEPA mandates 2.10 / Radar
    // signal), reused thereafter. Guests never get one. Partial-unique per tenant below.
    stripeCustomerId: text('stripe_customer_id'),
    metadata: jsonb('metadata').notNull().default({}),
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idTenantUq: unique('customers_id_tenant_uq').on(t.id, t.tenantId),
    // FUNCTIONAL partial-unique on (tenant_id, lower(email)) for ACTIVE rows only.
    // The lower makes uniqueness CASE-INSENSITIVE at the DB —
    // belt-and-braces behind the app's lowercasing on every write path, so a casing
    // bug can never create two active accounts for the same address. A
    // deleted/anonymized row never blocks a fresh signup (partial WHERE).
    activeEmailUq: uniqueIndex('customers_tenant_email_active_uq')
      .on(t.tenantId, sql`lower(${t.email})`)
      .where(sql`${t.deletedAt} is null and ${t.anonymizedAt} is null`),
    tenantIdx: index('customers_tenant_idx').on(t.tenantId),
    tenantB2bIdx: index('customers_tenant_is_b2b_idx').on(t.tenantId, t.isB2b),
    // One Stripe Customer per (tenant, customer); partial so the many null rows don't collide.
    stripeCustomerUq: uniqueIndex('customers_tenant_stripe_customer_uq')
      .on(t.tenantId, t.stripeCustomerId)
      .where(sql`${t.stripeCustomerId} is not null`),
    anonymizedChk: check(
      'customers_anonymized_chk',
      sql`${t.anonymizedAt} is null or (${t.email} like 'anonymized-%@deleted.local' and ${t.name} is null and ${t.phone} is null)`,
    ),
    // 2FA can only be ENABLED once a
    // secret is set — never `enabled=true` with a null secret.
    totpConsistencyChk: check(
      'customers_totp_consistency_chk',
      sql`${t.totpEnabled} = false OR ${t.totpSecret} IS NOT NULL`,
    ),
    // locale is a 2-char code OR null (null = unknown → default locale at render).
    localeChk: check(
      'customers_locale_chk',
      sql`${t.locale} is null or char_length(${t.locale}) = 2`,
    ),
  }),
);

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;
