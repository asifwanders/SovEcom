/**
 * OrderCreatedEvent.
 *
 * Emitted by `OrderService.createFromCart` AFTER the order + items + status history +
 * cart-conversion commit, under the fixed name `order.created`. Side-effect listeners
 * (confirmation email, analytics, discount usage) subscribe via `@OnEvent('order.created')`.
 * An absent listener is not an error. Emitting post-commit means a rolled-back creation
 * can never fire a phantom event.
 */
export class OrderCreatedEvent {
  static readonly EVENT_NAME = 'order.created';

  constructor(
    public readonly tenantId: string,
    public readonly orderId: string,
    public readonly cartId: string,
    public readonly customerId: string | null,
  ) {}
}
