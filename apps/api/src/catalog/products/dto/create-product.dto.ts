/**
 * CreateProductDto.
 *
 * - currency REQUIRED on every explicit variant (no default in DTO).
 * - price_amount ≥ 0 (integer cents).
 * - status cannot be 'published' if any non-free variant has price=0
 *   (enforced in the service, not the DTO).
 * - variant.options.free === true makes a 0-price variant intentionally free.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const VariantCreateSchema = z
  .object({
    sku: z.string().min(1).max(255).optional(),
    title: z.string().min(1).max(512).optional(),
    options: z.record(z.string(), z.unknown()).default({}),
    priceAmount: z.number().int().min(0),
    // ISO-4217: exactly 3 ASCII letters (not just length 3 — rejects "1$X" etc.).
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter ISO-4217 code')
      .toUpperCase(),
    compareAtAmount: z.number().int().min(0).optional().nullable(),
    stockQuantity: z.number().int().min(0).default(0),
    allowBackorder: z.boolean().default(false),
    weightGrams: z.number().int().min(0).optional().nullable(),
    lengthMm: z.number().int().min(0).optional().nullable(),
    widthMm: z.number().int().min(0).optional().nullable(),
    heightMm: z.number().int().min(0).optional().nullable(),
    position: z.number().int().min(0).default(0),
  })
  .strict();

export type VariantCreateInput = z.infer<typeof VariantCreateSchema>;

export const CreateProductSchema = z
  .object({
    title: z.string().min(1).max(512),
    slug: z.string().min(1).max(512).optional(),
    description: z.string().optional().nullable(),
    status: z.enum(['draft', 'published', 'archived']).default('draft'),
    seoTitle: z.string().max(512).optional().nullable(),
    seoDescription: z.string().max(1024).optional().nullable(),
    isBundle: z.boolean().default(false),
    variants: z.array(VariantCreateSchema).optional(),
  })
  .strict()
  // Single-currency-per-product: every variant in one product must share a currency.
  // A mixed-currency product (EUR + USD) breaks once Phase-2 sums line items, so reject
  // it at the boundary. Currencies are already upper-cased by the variant schema.
  .superRefine((data, ctx) => {
    const variants = data.variants ?? [];
    if (variants.length < 2) return;
    const first = variants[0]!.currency;
    for (let i = 1; i < variants.length; i++) {
      if (variants[i]!.currency !== first) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `All variants of a product must share one currency (found ${first} and ${variants[i]!.currency})`,
          path: ['variants', i, 'currency'],
        });
        break;
      }
    }
  });

export class CreateProductDto extends createZodDto(CreateProductSchema) {}
