/**
 * AttachImageDto / ReorderImagesDto (/ Fable).
 *
 * The global ZodValidationPipe only validates createZodDto classes — raw TS
 * `{ imageId, position? }` types were unvalidated and could reach Postgres as
 * garbage. These DTOs bound and type-check the input at the boundary.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const AttachImageSchema = z
  .object({
    imageId: z.string().uuid(),
    position: z.number().int().min(0).max(10000).default(0),
  })
  .strict();

export class AttachImageDto extends createZodDto(AttachImageSchema) {}

export const ReorderImagesSchema = z
  .object({
    order: z.array(z.string().uuid()).min(1),
  })
  .strict();

export class ReorderImagesDto extends createZodDto(ReorderImagesSchema) {}
