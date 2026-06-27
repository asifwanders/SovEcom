/**
 * Barrel for all Drizzle schema tables, enums and inferred types. Drizzle's
 * `schema` is built from these.
 *
 * Exported in dependency order so `.references()` resolve at module load.
 */
export * from './_enums';
export * from './_tenants';
export * from './users';
export * from './customers';
export * from './customer_addresses';
export * from './products';
export * from './product_variants';
export * from './product_images';
export * from './bundle_items';
export * from './categories';
export * from './product_categories';
export * from './tags';
export * from './product_tags';
export * from './audit_log';
export * from './setup_tokens';
export * from './system_state';
// Setup-wizard secrets at rest: AEAD ciphertext blobs,
// one row per (tenant_id, kind). After `_tenants` (already exported) so the FK resolves.
export * from './tenant_secrets';
export * from './sessions';
export * from './password_reset_tokens';
// customer email-change verification tokens.
// After `customers` (already exported above) so the composite FK resolves at load.
export * from './email_change_tokens';
// customer UNAUTH password-reset tokens.
// After `customers` (already exported above) so the composite FK resolves at load.
export * from './customer_password_reset_tokens';
export * from './images';

/* ---------------------------------------------------------------------------
 * Commerce schema — cart, order, payment, discount, shipping tables.
 * Ordered so composite-FK `foreignColumns` resolve at module load (parents
 * before children).
 * ------------------------------------------------------------------------- */
export * from './carts';
export * from './cart_items';
export * from './inventory_reservations';
export * from './orders';
export * from './order_items';
export * from './order_status_history';
export * from './order_counters';
export * from './invoices';
export * from './invoice_counters';
export * from './payments';
// Stripe integration: inbound provider-event idempotency log +
// disputes. After `payments` so the composite-FK `foreignColumns` resolve at module load.
export * from './payment_events';
export * from './disputes';
export * from './refunds';
export * from './refund_line_items';
export * from './returns';
export * from './discounts';
export * from './discount_usages';
export * from './tax_rates';
export * from './shipping_zones';
export * from './shipping_rates';
// Email notifications: transactional email send log.
export * from './email_logs';
// Outbound webhooks: subscriptions + delivery outbox.
export * from './webhook_subscriptions';
export * from './webhook_deliveries';

/* ---------------------------------------------------------------------------
 * Module runtime — registry of installed modules. After `_tenants` so the FK
 * resolves at load.
 * ------------------------------------------------------------------------- */
export * from './installed_modules';

/* ---------------------------------------------------------------------------
 * Module migration ledger — core-owned record of migrations per module.
 * (NOT module-writable).
 * ------------------------------------------------------------------------- */
export * from './module_migrations';

/* ---------------------------------------------------------------------------
 * Theme runtime — registry of installed themes (one active per tenant). After
 * `_tenants` so the FK resolves at load.
 * ------------------------------------------------------------------------- */
export * from './installed_themes';

/* ---------------------------------------------------------------------------
 * Slot registry conflict resolutions — admin-chosen winner per contested
 * (tenant, slot). After `_tenants` so the FK resolves at load.
 * ------------------------------------------------------------------------- */
export * from './module_slot_resolutions';

/* ---------------------------------------------------------------------------
 * CMS-lite content pages. Locale-aware
 * legal + marketing copy. After `_tenants` so the FK resolves at load.
 * ------------------------------------------------------------------------- */
export * from './pages';

/* ---------------------------------------------------------------------------
 * Storefront home sections — marketing section list singleton per tenant.
 * After `_tenants` so the FK resolves at load.
 * ------------------------------------------------------------------------- */
export * from './storefront_home_sections';
