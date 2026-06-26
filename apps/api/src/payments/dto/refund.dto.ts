/**
 * refund DTO. nestjs-zod `.strict`. Three modes:
 *   - `items` present  → line-item refund (per-line qty + optional restock);
 *   - `amount` present → arbitrary partial-amount refund;
 *   - neither          → full refund of the remaining balance (`restock` restocks all lines).
 * `items` and `amount` are mutually exclusive. Money is integer minor units.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const RefundSchema = z
  .object({
    reason: z.string().trim().min(1).max(1000).optional(),
    items: z
      .array(
        z
          .object({
            orderItemId: z.string().uuid(),
            quantity: z.number().int().positive(),
            restock: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    amount: z.number().int().positive().optional(),
    restock: z.boolean().optional(),
    /**
     * REQUIRED stable per-logical-refund key. The admin UI sends a key fixed for the whole
     * refund attempt, so a lost-response / double-click / transport retry REUSES it → Stripe
     * collapses the retries into ONE refund (no double money). Two intentionally-distinct refunds
     * (even same amount + reason) carry distinct keys, so both legitimately go through. It is
     * mandatory: without it a committed prior refund would shift any server-derived fallback key and
     * a retry would mint a SECOND real refund.
     */
    idempotencyKey: z.string().trim().min(1).max(255),
  })
  .strict()
  .refine((v) => !(v.items && v.amount !== undefined), {
    message: 'Provide either items or amount, not both',
  });

export class RefundDto extends createZodDto(RefundSchema) {}
