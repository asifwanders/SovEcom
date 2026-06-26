/**
 * CreateTagDto.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateTagSchema = z
  .object({
    name: z.string().min(1).max(512),
    slug: z.string().min(1).max(512).optional(),
  })
  .strict();

export class CreateTagDto extends createZodDto(CreateTagSchema) {}
