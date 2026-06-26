/**
 * CreateCategoryDto.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateCategorySchema = z
  .object({
    name: z.string().min(1).max(512),
    slug: z.string().min(1).max(512).optional(),
    parentId: z.string().uuid().optional().nullable(),
    position: z.number().int().min(0).default(0),
    description: z.string().optional().nullable(),
    seoTitle: z.string().max(512).optional().nullable(),
    seoDescription: z.string().max(1024).optional().nullable(),
  })
  .strict();

export class CreateCategoryDto extends createZodDto(CreateCategorySchema) {}
