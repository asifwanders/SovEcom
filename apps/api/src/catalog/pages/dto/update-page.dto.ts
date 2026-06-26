/**
 * UpdatePageDto.
 *
 * Partial of create: every field optional. `.strict()` still rejects unknown
 * keys. No field becomes nullable that wasn't already (seo* stay nullable).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PAGE_BODY_MAX } from './create-page.dto';

export const UpdatePageSchema = z
  .object({
    slug: z.string().trim().min(1).max(512).optional(),
    title: z.string().min(1).max(512).optional(),
    body: z.string().min(1).max(PAGE_BODY_MAX).optional(),
    locale: z.enum(['fr', 'en']).optional(),
    status: z.enum(['draft', 'published']).optional(),
    seoTitle: z.string().max(512).optional().nullable(),
    seoDescription: z.string().max(1024).optional().nullable(),
  })
  .strict();

export class UpdatePageDto extends createZodDto(UpdatePageSchema) {}
