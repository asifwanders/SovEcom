/**
 * Discount admin DTOs.
 *
 * nestjs-zod `createZodDto` with `.strict()`. Dates are ISO strings +
 * `.transform(s => new Date(s))` — NEVER `z.coerce.date()` / `z.date()` (breaks
 * SwaggerModule JSON-schema generation). Money/value fields are non-negative integers.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Optional nullable ISO-8601 datetime that transforms to a Date (or null). */
const isoDateNullable = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s))
  .nullable()
  .optional();

const code = z.string().trim().min(1).max(64);
const value = z.number().int().nonnegative();
const cents = z.number().int().nonnegative();
const segment = z.enum(['all', 'first_time', 'returning', 'b2b']);
const currency = z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code');
const targetIds = z.array(z.string().uuid()).max(1000);

// ── Create ───────────────────────────────────────────────────────────────────

export const CreateDiscountSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    /** null / omitted = automatic discount (always evaluated, no code needed). */
    code: code.nullable().optional(),
    type: z.enum(['percentage', 'fixed']),
    /** percentage points ×100 (e.g. 10% = 1000) OR fixed minor units. */
    value,
    /** Only meaningful for `fixed`; must match the cart currency to apply. */
    currency: currency.nullable().optional(),
    minCartAmount: cents.nullable().optional(),
    appliesTo: z.enum(['all', 'products', 'categories']).default('all'),
    /** product ids (products scope) or category ids (categories scope). */
    targetIds: targetIds.nullable().optional(),
    customerSegment: segment.nullable().optional(),
    stackable: z.boolean().default(false),
    usageLimitTotal: z.number().int().positive().nullable().optional(),
    usageLimitPerCustomer: z.number().int().positive().nullable().optional(),
    startsAt: isoDateNullable,
    endsAt: isoDateNullable,
    active: z.boolean().default(true),
  })
  .strict()
  .refine((d) => d.appliesTo === 'all' || (d.targetIds != null && d.targetIds.length > 0), {
    message: 'targetIds is required and non-empty for products/categories scope',
    path: ['targetIds'],
  })
  .refine((d) => d.type !== 'percentage' || d.value <= 10000, {
    message: 'percentage value must be ≤ 10000 (100.00%)',
    path: ['value'],
  })
  .refine((d) => d.type !== 'fixed' || d.currency != null, {
    message: 'currency is required for a fixed-amount discount (else it applies in any currency)',
    path: ['currency'],
  });

export class CreateDiscountDto extends createZodDto(CreateDiscountSchema) {}

// ── Update (PATCH semantics; all fields optional) ────────────────────────────

export const UpdateDiscountSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    code: code.nullable().optional(),
    type: z.enum(['percentage', 'fixed']).optional(),
    value: value.optional(),
    currency: currency.nullable().optional(),
    minCartAmount: cents.nullable().optional(),
    appliesTo: z.enum(['all', 'products', 'categories']).optional(),
    targetIds: targetIds.nullable().optional(),
    customerSegment: segment.nullable().optional(),
    stackable: z.boolean().optional(),
    usageLimitTotal: z.number().int().positive().nullable().optional(),
    usageLimitPerCustomer: z.number().int().positive().nullable().optional(),
    startsAt: isoDateNullable,
    endsAt: isoDateNullable,
    active: z.boolean().optional(),
  })
  .strict();

export class UpdateDiscountDto extends createZodDto(UpdateDiscountSchema) {}

// ── Apply discount to cart (store) ───────────────────────────────────────────

export const ApplyDiscountSchema = z
  .object({
    code: code,
  })
  .strict();

export class ApplyDiscountDto extends createZodDto(ApplyDiscountSchema) {}
