/**
 * CartConflictException.
 *
 * Thrown when the cart's optimistic WATCH/retry loop exhausts its retry budget:
 * a concurrent writer kept changing the cart key on every attempt. Maps to HTTP
 * 409 so the client can retry the mutation. In practice this is extremely rare —
 * the loop normally converges in 1-2 attempts — but it bounds the loop instead
 * of spinning forever under pathological contention.
 */
import { ConflictException } from '@nestjs/common';

export class CartConflictException extends ConflictException {
  constructor(cartId: string) {
    super({
      statusCode: 409,
      error: 'Cart Conflict',
      message: `Cart ${cartId} is being modified concurrently; please retry`,
    });
  }
}
