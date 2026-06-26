/**
 * AssignCategoriesDto.
 *
 * Used for PUT /admin/v1/products/:id/categories — replace-set semantics.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const AssignCategoriesSchema = z
  .object({
    // F4 (Fable): collapse duplicate ids to a set up front so the payload is a
    // genuine replace-SET and can never violate the junction PK with [X, X].
    categoryIds: z
      .array(z.string().uuid())
      .max(100)
      .transform((ids) => Array.from(new Set(ids))),
  })
  .strict();

export class AssignCategoriesDto extends createZodDto(AssignCategoriesSchema) {}
