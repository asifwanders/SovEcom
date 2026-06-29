/**
 * ProductQueryDto.
 *
 * Admin offset pagination + filter/sort. Store cursor pagination is
 * handled as plain query params (no DTO class needed — validated inline).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ProductQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(20),
    q: z.string().trim().min(1).max(200).optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    category: z.string().uuid().optional(),
    tag: z.string().uuid().optional(),
    priceMin: z.coerce.number().int().min(0).optional(),
    priceMax: z.coerce.number().int().min(0).optional(),
    inStock: z
      .string()
      .optional()
      .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
    sort: z.enum(['created', 'title', 'price']).default('created'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();

export class ProductQueryDto extends createZodDto(ProductQuerySchema) {}
