/**
 * InsufficientStockException.
 *
 * Thrown by InventoryService.reserve() when a requested quantity exceeds the
 * available stock (stock minus other carts' active reservations) for a variant
 * that does NOT allow backorder. Extends ConflictException so NestJS maps it to
 * HTTP 409, and carries the variant/requested/available context for the client.
 */
import { ConflictException } from '@nestjs/common';

export class InsufficientStockException extends ConflictException {
  constructor(
    readonly variantId: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super({
      statusCode: 409,
      error: 'Insufficient Stock',
      message: `Insufficient stock for variant ${variantId}: requested ${requested}, available ${available}`,
      variantId,
      requested,
      available,
    });
  }
}
