/**
 * ProductDeletedEvent.
 */
export class ProductDeletedEvent {
  static readonly EVENT = 'product.deleted' as const;

  constructor(
    public readonly tenantId: string,
    public readonly productId: string,
  ) {}
}
