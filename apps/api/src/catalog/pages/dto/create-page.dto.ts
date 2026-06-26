/**
 * CreatePageDto.
 *
 * Zod `.strict()` so an unknown key is a 400, never silently dropped. `locale`
 * and `status` are closed enums (FR/EN; draft/published). `body` carries a sane
 * upper bound so an admin cannot push an unbounded blob into the public render
 * path. `seoTitle`/`seoDescription` are nullable-optional metadata.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Max authored body length (chars). A generous CMS-page cap, not a novel. */
export const PAGE_BODY_MAX = 100_000;

export const CreatePageSchema = z
  .object({
    slug: z.string().trim().min(1).max(512),
    title: z.string().min(1).max(512),
    body: z.string().min(1).max(PAGE_BODY_MAX),
    locale: z.enum(['fr', 'en']),
    status: z.enum(['draft', 'published']).default('draft'),
    seoTitle: z.string().max(512).optional().nullable(),
    seoDescription: z.string().max(1024).optional().nullable(),
  })
  .strict();

export class CreatePageDto extends createZodDto(CreatePageSchema) {}
