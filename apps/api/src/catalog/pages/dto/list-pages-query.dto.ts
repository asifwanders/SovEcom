/**
 * ListPagesQueryDto.
 *
 * Optional admin list filters. `.strict()` rejects unknown query keys (400).
 * Both filters are closed enums so a bad value is a 400, never a silent
 * full-table scan with a garbage predicate.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ListPagesQuerySchema = z
  .object({
    locale: z.enum(['fr', 'en']).optional(),
    status: z.enum(['draft', 'published']).optional(),
  })
  .strict();

export class ListPagesQueryDto extends createZodDto(ListPagesQuerySchema) {}
