import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Native Postgres enums for core entities.
 *
 * Native pg enums (not plain text) per DB conventions. `actor_type` carries
 * the audited actor kinds.
 */

/** Tenant lifecycle. */
export const tenantStatusEnum = pgEnum('tenant_status', [
  'active',
  'suspended',
  'provisioning',
  'decommissioned',
]);

/** Admin/operator account roles (no `viewer`). */
export const userRoleEnum = pgEnum('user_role', ['owner', 'admin', 'staff']);

/** Customer address kind. */
export const addressTypeEnum = pgEnum('address_type', ['shipping', 'billing']);

/** Product lifecycle. */
export const productStatusEnum = pgEnum('product_status', ['draft', 'published', 'archived']);

/** Audit-log actor kinds. */
export const actorTypeEnum = pgEnum('actor_type', [
  'user',
  'customer',
  'system',
  'api',
  'anonymous',
]);

/* ---------------------------------------------------------------------------
 * Commerce enums.
 * Native pg enums (status columns are enums, never plain text).
 * ------------------------------------------------------------------------- */

/** Stock reservation lifecycle. `consumed=true` maps to `confirmed`. */
export const reservationStatusEnum = pgEnum('reservation_status', [
  'reserved',
  'confirmed',
  'released',
]);

/** Cart lifecycle. */
export const cartStatusEnum = pgEnum('cart_status', ['active', 'converted', 'abandoned']);

/** Order lifecycle. */
export const orderStatusEnum = pgEnum('order_status', [
  'pending_payment',
  'paid',
  'fulfilled',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'refunded',
  'partially_refunded',
]);

/** Fiscal document kind. */
export const invoiceTypeEnum = pgEnum('invoice_type', ['invoice', 'credit_note']);

/** Return / 14-day withdrawal request kind. */
export const returnTypeEnum = pgEnum('return_type', ['return', 'withdrawal']);

/** Return request lifecycle. */
export const returnStatusEnum = pgEnum('return_status', [
  'requested',
  'approved',
  'rejected',
  'refunded',
]);

/**
 * Payment lifecycle. `processing` is appended for ASYNC methods (SEPA Direct Debit):
 * the payment is confirmed but funds have not cleared, so the order stays
 * `pending_payment` until the payment is confirmed.
 */
export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'succeeded',
  'failed',
  'cancelled',
  'processing',
]);

/** Refund lifecycle. */
export const refundStatusEnum = pgEnum('refund_status', ['pending', 'succeeded', 'failed']);

/**
 * Dispute / chargeback lifecycle. A COARSE workflow status
 * (the verbatim Stripe status string is kept in `disputes.provider_status`):
 *   `open`  — created / needs response / under review — fulfillment is FROZEN.
 *   `won`   — closed in the merchant's favour (funds returned).
 *   `lost`  — closed against the merchant (funds withdrawn; money reconciliation = 2.11).
 */
export const disputeStatusEnum = pgEnum('dispute_status', ['open', 'won', 'lost']);

/** Discount value kind. */
export const discountTypeEnum = pgEnum('discount_type', ['percentage', 'fixed']);

/** Discount applicability scope. */
export const discountScopeEnum = pgEnum('discount_scope', ['all', 'products', 'categories']);

/** Shipping rate pricing strategy. */
export const shippingRateTypeEnum = pgEnum('shipping_rate_type', [
  'flat',
  'free_over',
  'weight_based',
]);

/**
 * Transactional email kind. One value per template the system
 * sends through `EmailNotificationService`. Password-reset goes via the direct MailService
 * path (security-sensitive, not order-bound) and is NOT logged here.
 */
export const emailTypeEnum = pgEnum('email_type', [
  'order_confirmation',
  'order_shipped',
  'refund_issued',
]);

/**
 * Outcome of a transactional email send. One `email_logs` row is
 * written per send with the FINAL outcome after the inline retry loop. `failed` is the admin's
 * signal to resend.
 */
export const emailStatusEnum = pgEnum('email_status', ['sent', 'failed']);

/**
 * Outbound webhook delivery lifecycle. `pending` = queued
 * /due; `delivered` = a 2xx response; `failed` = a retryable error (will retry at `next_retry_at`);
 * `exhausted` = the backoff schedule ran out (no more auto-retry; admin can retry manually).
 */
export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'delivered',
  'failed',
  'exhausted',
]);

/**
 * CMS-lite content-page lifecycle. `draft`
 * pages are admin-only; `published` pages are servable by the storefront.
 */
export const pageStatusEnum = pgEnum('page_status', ['draft', 'published']);
