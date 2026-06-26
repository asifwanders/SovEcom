/**
 * UpdateProductDto (, PATCH semantics).
 *
 * All fields optional. Publish guard enforced in service.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateProductSchema = z
  .object({
    title: z.string().min(1).max(512).optional(),
    slug: z.string().min(1).max(512).optional(),
    description: z.string().optional().nullable(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    seoTitle: z.string().max(512).optional().nullable(),
    seoDescription: z.string().max(1024).optional().nullable(),
    isBundle: z.boolean().optional(),
  })
  .strict();

export class UpdateProductDto extends createZodDto(UpdateProductSchema) {}
