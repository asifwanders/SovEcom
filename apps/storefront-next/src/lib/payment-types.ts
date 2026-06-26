/**
 * payment/order response view-types.
 *
 * client-js types request paths/bodies but NOT response bodies, so the storefront owns
 * these shapes. They mirror the REAL backend serializers:
 *   - `PaymentIntentResponse`  ← `apps/api/src/payments/payments.service.ts` (the payment-intent body).
 *   - `CheckoutOrderResponse`  ← `apps/api/src/orders/orders.controller.store.ts` `checkout()` (order +
 *     the one-time `guestAccessToken`).
 *   - `OrderView`              ← the order-read serializers (`orders-read.controller.store.ts` JWT /
 *     `orders-guest.controller.store.ts` X-Order-Token). MONEY fields are integer minor units.
 *
 * MONEY-CRITICAL: every amount is an integer minor-unit value straight off the server; the storefront
 * never does arithmetic on these — they render via `formatPrice`.
 */

/** The `POST /store/v1/carts/{id}/payment-intent` response (PaymentsService.PaymentIntentResponse). */
export interface PaymentIntentResponse {
  orderId: string;
  /**
   * `requires_payment` → confirm with `clientSecret`; `paid` → already settled (nothing to pay — drive
   * straight to confirmation, the browser-back / re-entry idempotency case); `processing` → an async
   * (SEPA) payment is already clearing → the client must NOT start a new one.
   */
  status: 'requires_payment' | 'paid' | 'processing';
  clientSecret: string | null;
  amount: number;
  currency: string;
}

/**
 * The `POST /store/v1/carts/{id}/checkout` response: the created order PLUS the one-time
 * `guestAccessToken` (surfaced EXACTLY once — used as the `X-Order-Token` for the guest order lookup).
 */
export interface CheckoutOrderResponse {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  email: string | null;
  totalAmount: number;
  /** Present once at checkout for a guest order; the storefront stashes it for the success page. */
  guestAccessToken?: string | null;
}

/** A single order line in a confirmation read (order-read / guest serializers). */
export interface OrderItemView {
  id: string;
  productTitle: string;
  variantTitle: string | null;
  sku: string;
  quantity: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
}

/** The order confirmation view (logged-in via JWT or guest via X-Order-Token). Money = minor units. */
export interface OrderView {
  id: string;
  orderNumber: string;
  status: string;
  currency: string;
  email: string | null;
  subtotalAmount: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  shippingMethod: string | null;
  shippingAddress: unknown | null;
  billingAddress: unknown | null;
  placedAt: string | null;
  createdAt: string;
  items?: OrderItemView[];
  // --- List-endpoint additional fields (present on /store/v1/orders responses; optional so the
  //     detail-only OrderView shape remains compatible). Never compute from these client-side.
  discountCode?: string | null;
  refundedAmount?: number | null;
  trackingNumber?: string | null;
  carrier?: string | null;
}

/**
 * customer return / 14-day right-of-withdrawal request view-types.
 *
 * MIRRORS the API serializers for the customer returns endpoints (client-js types
 * bodies but not responses, so the storefront owns the response shape):
 *   - `POST /store/v1/customers/me/orders/{orderId}/returns` → 201 `ReturnView`.
 *   - `GET  /store/v1/customers/me/orders/{orderId}/returns` → `ReturnView[]`.
 *
 * No money fields here — the return request never carries amounts (the admin approve→refund flow
 * computes the refund). `withinWithdrawalWindow` is the server's authoritative statement of whether
 * the request landed inside the EU statutory 14-day window; surfaced read-only/informational.
 */

/** The request body for creating a return / withdrawal (mirrors the API `CreateReturnDto`). */
export interface CreateReturnInput {
  type: 'return' | 'withdrawal';
  items: { orderItemId: string; quantity: number }[];
  reason?: string;
}

/** A single requested line within a return. */
export interface ReturnItemView {
  orderItemId: string;
  quantity: number;
}

/** The return status enum the server returns over a return's lifecycle. */
export type ReturnStatus = 'requested' | 'approved' | 'rejected' | 'refunded';

/** A return / withdrawal request as serialized by the customer returns endpoints. */
export interface ReturnView {
  id: string;
  orderId: string;
  type: 'return' | 'withdrawal';
  status: ReturnStatus;
  items: ReturnItemView[];
  reason: string | null;
  withinWithdrawalWindow: boolean;
  requestedAt: string;
  refundId: string | null;
}

/**
 * Narrowed view of a JSONB address snapshot returned by the order endpoints.
 * The server stores these as `unknown` JSONB; we narrow defensively — every field is optional.
 * Mirrors `SavedAddress` in auth-context.tsx but without the metadata fields (id, type, isDefault).
 */
export interface OrderAddressView {
  name?: string;
  company?: string | null;
  line1?: string;
  line2?: string | null;
  city?: string;
  postalCode?: string;
  region?: string | null;
  country?: string;
  phone?: string | null;
}
