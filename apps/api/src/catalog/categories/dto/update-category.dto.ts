/**
 * UpdateCategoryDto.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateCategorySchema = z
  .object({
    name: z.string().min(1).max(512).optional(),
    slug: z.string().min(1).max(512).optional(),
    parentId: z.string().uuid().optional().nullable(),
    position: z.number().int().min(0).optional(),
    description: z.string().optional().nullable(),
    seoTitle: z.string().max(512).optional().nullable(),
    seoDescription: z.string().max(1024).optional().nullable(),
  })
  .strict();

export class UpdateCategoryDto extends createZodDto(UpdateCategorySchema) {}
