/**
 * UpdateVariantDto (, PATCH semantics).
 *
 * currency REQUIRED only when priceAmount is also supplied (enforced in service).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateVariantSchema = z
  .object({
    sku: z.string().min(1).max(255).optional(),
    title: z.string().min(1).max(512).optional().nullable(),
    options: z.record(z.string(), z.unknown()).optional(),
    priceAmount: z.number().int().min(0).optional(),
    // ISO-4217: exactly 3 ASCII letters (rejects non-alpha junk).
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter ISO-4217 code')
      .toUpperCase()
      .optional(),
    compareAtAmount: z.number().int().min(0).optional().nullable(),
    stockQuantity: z.number().int().min(0).optional(),
    allowBackorder: z.boolean().optional(),
    weightGrams: z.number().int().min(0).optional().nullable(),
    lengthMm: z.number().int().min(0).optional().nullable(),
    widthMm: z.number().int().min(0).optional().nullable(),
    heightMm: z.number().int().min(0).optional().nullable(),
    position: z.number().int().min(0).optional(),
  })
  .strict();

export class UpdateVariantDto extends createZodDto(UpdateVariantSchema) {}
