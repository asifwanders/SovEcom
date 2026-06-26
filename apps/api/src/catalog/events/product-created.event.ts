/**
 * ProductCreatedEvent.
 *
 * Emitted INSIDE the create-product transaction (ordering guarantee).
 * search adds a listener; an absent listener is not an error.
 */
export class ProductCreatedEvent {
  static readonly EVENT = 'product.created' as const;

  constructor(
    public readonly tenantId: string,
    public readonly productId: string,
    public readonly title: string,
    public readonly status: string,
  ) {}
}
