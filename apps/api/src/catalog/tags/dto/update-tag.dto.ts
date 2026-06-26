/**
 * UpdateTagDto.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateTagSchema = z
  .object({
    name: z.string().min(1).max(512).optional(),
    slug: z.string().min(1).max(512).optional(),
  })
  .strict();

export class UpdateTagDto extends createZodDto(UpdateTagSchema) {}
