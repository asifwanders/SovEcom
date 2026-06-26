/**
 * CustomerQueryDto (admin list/filter/paginate).
 *
 * Offset pagination (mirrors ProductQueryDto). `email` is a substring filter,
 * `isB2b` a boolean facet. Tenant scoping is enforced in the repository, never a
 * query param.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CustomerQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(20),
    email: z.string().min(1).max(320).optional(),
    isB2b: z
      .string()
      .optional()
      .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
  })
  .strict();

export class CustomerQueryDto extends createZodDto(CustomerQuerySchema) {}
