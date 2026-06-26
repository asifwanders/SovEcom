/**
 * Image upload query DTO.
 *
 * `alt_text` arrives as an unbounded, unvalidated query param and is stored into an
 * unbounded text column. Validate it at the boundary: trim + cap length so an attacker
 * can't push arbitrary-size payloads into the DB. Over-long → 400 (global ZodValidationPipe).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Max persisted alt-text length (well above any legitimate accessibility caption). */
export const ALT_TEXT_MAX = 1000;

export const ImageUploadQuerySchema = z
  .object({
    alt_text: z.string().trim().max(ALT_TEXT_MAX).optional(),
  })
  .strict();

export class ImageUploadQueryDto extends createZodDto(ImageUploadQuerySchema) {}
