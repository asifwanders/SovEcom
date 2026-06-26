/**
 * ReorderVariantsDto.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ReorderVariantsSchema = z
  .object({
    order: z.array(z.string().uuid()).min(1),
  })
  .strict();

export class ReorderVariantsDto extends createZodDto(ReorderVariantsSchema) {}
