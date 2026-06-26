/**
 * Admin reservation-list query DTO.
 *
 * Optional `?variantId=` filter. `.strict()` rejects unknown params; no
 * z.coerce.date / z.date (ADR convention — dates are never parsed from query).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ReservationQuerySchema = z
  .object({
    variantId: z.string().uuid().optional(),
  })
  .strict();

export class ReservationQueryDto extends createZodDto(ReservationQuerySchema) {}
