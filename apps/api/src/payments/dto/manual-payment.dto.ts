/**
 * Manual/offline payment DTO. nestjs-zod `.strict`.
 *
 * `method` is the offline channel the admin recorded (bank transfer / cash-on-delivery / cash /
 * other). `amount` is optional integer minor units; when omitted the service uses the order total
 * (the common "mark fully paid" case). Money is always integer minor units.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ManualPaymentSchema = z
  .object({
    method: z.enum(['bank_transfer', 'cod', 'cash', 'other']),
    amount: z.number().int().positive().optional(),
  })
  .strict();
export class ManualPaymentDto extends createZodDto(ManualPaymentSchema) {}
