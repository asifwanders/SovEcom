/**
 * shared order-status helpers.
 *
 * The order endpoints return a `status` string from a fixed 9-value enum. The storefront translates
 * each via the `account.orders.status_<value>` message keys. An UNKNOWN value (forward-compat with a
 * future status the catalog doesn't yet translate) falls back to the raw server string so the UI is
 * never blank.
 */
import { useTranslations } from 'next-intl';

/** The 9 canonical order status values the server returns. */
export const STATUS_KEYS = [
  'pending_payment',
  'paid',
  'fulfilled',
  'shipped',
  'delivered',
  'completed',
  'cancelled',
  'refunded',
  'partially_refunded',
] as const;

export type OrderStatus = (typeof STATUS_KEYS)[number];

export function isOrderStatus(s: string): s is OrderStatus {
  return (STATUS_KEYS as readonly string[]).includes(s);
}

/**
 * Order statuses for which an invoice/receipt document exists. The invoice is issued on the
 * `order.paid` event, so it exists for `paid` and every status beyond it (including the refunded
 * ones — the original invoice still exists). It does NOT exist for `pending_payment` (never paid) or
 * `cancelled` (cancelled before/without payment), so the invoice-download affordance must hide for
 * those — clicking would only ever 404.
 */
const INVOICED_STATUSES = new Set<OrderStatus>([
  'paid',
  'fulfilled',
  'shipped',
  'delivered',
  'completed',
  'refunded',
  'partially_refunded',
]);

/** True when an invoice/receipt document plausibly exists for an order in the given status. */
export function orderHasInvoice(status: string): boolean {
  return INVOICED_STATUSES.has(status as OrderStatus);
}

/**
 * order statuses for which a customer return / 14-day right-of-withdrawal
 * request is accepted. MIRRORS the server's authority (the API rejects others with 422); this is a
 * UI affordance gate only — the server remains the source of truth. Returnable = the order has been
 * paid and not already fully resolved: `paid`, `fulfilled`, `shipped`, `delivered`, and
 * `partially_refunded`. NOT returnable: `pending_payment` (never paid), `completed` (closed),
 * `cancelled` (no goods), `refunded` (already fully refunded), or any unknown value.
 */
const RETURNABLE_STATUSES = new Set<OrderStatus>([
  'paid',
  'fulfilled',
  'shipped',
  'delivered',
  'partially_refunded',
]);

/** True when an order in the given status is eligible for a customer return / withdrawal request. */
export function orderIsReturnable(status: string): boolean {
  return RETURNABLE_STATUSES.has(status as OrderStatus);
}

/**
 * Hook returning a `translate(status)` function bound to the `account.orders` namespace. Known enum
 * values map to `status_<value>`; an unknown value returns the raw string verbatim (never blank).
 */
export function useOrderStatusTranslator(): (status: string) => string {
  const t = useTranslations('account.orders');
  return (status: string): string => {
    if (isOrderStatus(status)) {
      return t(`status_${status}` as Parameters<typeof t>[0]);
    }
    return status;
  };
}
