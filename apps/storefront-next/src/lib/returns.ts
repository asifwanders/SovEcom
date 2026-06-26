/**
 * typed helpers for the customer returns / 14-day right-of-withdrawal endpoints
 * (REFUND-PATH-ADJACENT: the request feeds the admin approve→refund flow; this layer NEVER computes
 * money or a refund — it only relays the request and reads back the server's authoritative response).
 *
 * Endpoints (exist; CustomerAuthGuard + IDOR-scoped — the server 404s if the order is not owned by
 * the authenticated customer, 422s on a non-returnable status or an over-quantity item):
 *   POST /store/v1/customers/me/orders/{orderId}/returns  → 201 ReturnView
 *   GET  /store/v1/customers/me/orders/{orderId}/returns  → ReturnView[]
 *
 * Callers (ReturnRequest) own the 401→refresh()-once→retry loop and surface the 422 message.
 */
import type { SovEcomClient } from '@sovecom/client-js';
import type { CreateReturnInput, ReturnView } from './payment-types';

/** Create a return / withdrawal request for an order. Returns the server-shaped `ReturnView`. */
export async function createReturn(
  client: SovEcomClient,
  orderId: string,
  body: CreateReturnInput,
): Promise<ReturnView> {
  return client.request<'/store/v1/customers/me/orders/{orderId}/returns', 'post', ReturnView>(
    'post',
    '/store/v1/customers/me/orders/{orderId}/returns',
    {
      path: { orderId },
      body,
    },
  );
}

/** Fetch the existing returns for an order (may be empty). */
export async function listReturns(client: SovEcomClient, orderId: string): Promise<ReturnView[]> {
  return client.request<'/store/v1/customers/me/orders/{orderId}/returns', 'get', ReturnView[]>(
    'get',
    '/store/v1/customers/me/orders/{orderId}/returns',
    {
      path: { orderId },
    },
  );
}

/**
 * Best-effort extraction of a human-readable message from a `SovEcomApiError`-shaped error body.
 * NestJS validation/HTTP errors serialize as `{ message: string | string[], statusCode, error }`;
 * a 422 from the returns endpoint (non-returnable status / quantity exceeds remaining) carries the
 * actionable text there. Returns `null` when no usable string is present so the caller falls back to
 * a localized message — we NEVER invent or compute a message.
 */
export function apiErrorMessage(err: unknown): string | null {
  const body = (err as { body?: unknown })?.body;
  if (body && typeof body === 'object') {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
    if (Array.isArray(message)) {
      const joined = message.filter((m) => typeof m === 'string' && m.trim() !== '').join('; ');
      if (joined !== '') return joined;
    }
  }
  return null;
}
