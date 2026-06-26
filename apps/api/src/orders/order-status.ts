/**
 * Order state machine.
 *
 * A frozen typed adjacency map of allowed `orders.status` transitions plus a pure
 * `canTransition` predicate and an `assertTransition` guard that throws a 422 on an
 * illegal edge. This is the spec of order lifecycle validity — kept pure for easy testing.
 * Side effects (invoice, stock restore, emails) live in event listeners, never here.
 *
 * Allowed transitions:
 *   pending_payment → paid | cancelled
 *   paid            → fulfilled | cancelled | refunded | partially_refunded
 *   fulfilled       → shipped  | refunded | partially_refunded
 *   shipped         → delivered | refunded | partially_refunded
 *   delivered       → completed | refunded | partially_refunded
 *   partially_refunded → refunded | partially_refunded
 *
 * Terminal (no outgoing edges): completed, cancelled, refunded.
 * Self-transitions are illegal except the explicit `partially_refunded → partially_refunded` edge.
 */
import { UnprocessableEntityException } from '@nestjs/common';
import { orderStatusEnum } from '../database/schema/_enums';

/** The order lifecycle states (the exact `order_status` enum values). */
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];

/**
 * Frozen adjacency map: `from` → the set of `to` states reachable in one legal step.
 * Terminal states map to an empty array.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> =
  Object.freeze({
    pending_payment: Object.freeze(['paid', 'cancelled'] as const),
    paid: Object.freeze(['fulfilled', 'cancelled', 'refunded', 'partially_refunded'] as const),
    fulfilled: Object.freeze(['shipped', 'refunded', 'partially_refunded'] as const),
    shipped: Object.freeze(['delivered', 'refunded', 'partially_refunded'] as const),
    delivered: Object.freeze(['completed', 'refunded', 'partially_refunded'] as const),
    partially_refunded: Object.freeze(['refunded', 'partially_refunded'] as const),
    // Terminal states — no outgoing edges.
    completed: Object.freeze([] as const),
    cancelled: Object.freeze([] as const),
    refunded: Object.freeze([] as const),
  });

/** The terminal states (no outgoing transitions). */
export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = Object.freeze([
  'completed',
  'cancelled',
  'refunded',
] as const);

/** True iff `status` is terminal (no legal outgoing transition exists). */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return ORDER_TRANSITIONS[status].length === 0;
}

/**
 * Pure predicate: is `from → to` a legal single-step transition?
 *
 * Self-transitions are illegal except for the explicit `partially_refunded` edge
 * encoded in the map. Terminal `from` states always return false.
 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/**
 * Guard: assert `from → to` is legal, else throw a 422.
 *
 * @throws UnprocessableEntityException (422) on an illegal edge — terminal states,
 *   unknown edges, and illegal self-transitions all reject here.
 */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new UnprocessableEntityException(`Illegal order status transition: ${from} → ${to}`);
  }
}
