/**
 * ProductUpdatedEvent.
 */
export class ProductUpdatedEvent {
  static readonly EVENT = 'product.updated' as const;

  constructor(
    public readonly tenantId: string,
    public readonly productId: string,
    public readonly changes: Record<string, unknown>,
  ) {}
}
