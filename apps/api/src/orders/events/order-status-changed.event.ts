/**
 * OrderStatusChangedEvent.
 *
 * Emitted by `OrderService.transition` AFTER the status update + history row commit,
 * under the per-target event name `order.<to>` (e.g. `order.paid`, `order.cancelled`).
 * Side-effect listeners (invoice issuance, stock restore on cancel, emails) subscribe
 * via `@OnEvent('order.paid')` etc. An absent listener is not an error.
 */
import type { OrderStatus } from '../order-status';

export class OrderStatusChangedEvent {
  /** Build the per-target event name, e.g. `order.paid`. */
  static eventName(to: OrderStatus): `order.${OrderStatus}` {
    return `order.${to}`;
  }

  constructor(
    public readonly tenantId: string,
    public readonly orderId: string,
    public readonly fromStatus: OrderStatus,
    public readonly toStatus: OrderStatus,
    public readonly changedBy: string | null,
  ) {}
}
