/**
 * Cart authorisation (shared by CartService + CartAssociateService).
 *
 * A caller may present EITHER the cart-token cookie OR a customer JWT. Messages are
 * uniform (never reveal token validity or cart existence).
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { CartState } from './cart.types';
import type { AuthenticatedCustomer } from '../customers/auth/authenticated-customer';

export function authoriseCart(
  state: CartState | null,
  cartId: string,
  cartToken: string | undefined,
  customer: AuthenticatedCustomer | undefined,
): asserts state is CartState {
  if (!state || state.status === 'abandoned') {
    // No credential → 403 (don't acknowledge the cart); credential but no live cart
    // → 404. Uniform messages never reveal token validity (S10).
    if (!cartToken && !customer) {
      throw new ForbiddenException('Access denied');
    }
    throw new NotFoundException(`Cart ${cartId} not found`);
  }

  // Customer JWT path: the principal must own this cart AND share its tenant (B4).
  if (customer) {
    if (
      state.customerId &&
      state.customerId === customer.id &&
      state.tenantId === customer.tenantId
    ) {
      return; // authorised via owning-customer JWT
    }
    // Otherwise fall back to the cart token (e.g. associating a guest cart).
    if (cartToken && state.sessionToken === cartToken) {
      return;
    }
    throw new ForbiddenException('Access denied');
  }

  // Token-only path. Uniform 403 — never distinguish "wrong token" from "no token".
  if (!cartToken || state.sessionToken !== cartToken) {
    throw new ForbiddenException('Access denied');
  }
}
