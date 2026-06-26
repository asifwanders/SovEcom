/**
 * Shipping zone + rate admin DTOs. nestjs-zod `.strict`.
 * No date fields (keeps Swagger JSON-schema generation happy). Money is integer
 * minor units; currency is a 3-letter ISO 4217 code.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'country must be a 2-letter ISO 3166-1 alpha-2 code')
  .transform((s) => s.toUpperCase());

const currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter ISO 4217 code')
  .transform((s) => s.toUpperCase());

const minorAmount = z.number().int().min(0, 'amount must be a non-negative integer (minor units)');
const grams = z.number().int().min(0, 'weight must be a non-negative integer (grams)');

// ── Zones ─────────────────────────────────────────────────────────────────────

export const CreateZoneSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    countries: z.array(country).min(1, 'a zone must list at least one country').max(250),
  })
  .strict();
export class CreateZoneDto extends createZodDto(CreateZoneSchema) {}

export const UpdateZoneSchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    countries: z.array(country).min(1).max(250).optional(),
  })
  .strict();
export class UpdateZoneDto extends createZodDto(UpdateZoneSchema) {}

// ── Rates ─────────────────────────────────────────────────────────────────────

const rateType = z.enum(['flat', 'free_over', 'weight_based']);

/** free_over needs a threshold (else it could never be free). */
const freeOverHasThreshold = (v: {
  type?: 'flat' | 'free_over' | 'weight_based';
  freeOverAmount?: number | null;
}): boolean =>
  v.type !== 'free_over' || (v.freeOverAmount !== undefined && v.freeOverAmount !== null);

/** A weight band, when both bounds are set, must have min ≤ max. */
const bandIsOrdered = (v: {
  weightMinGrams?: number | null;
  weightMaxGrams?: number | null;
}): boolean =>
  v.weightMinGrams == null || v.weightMaxGrams == null || v.weightMinGrams <= v.weightMaxGrams;

export const CreateRateSchema = z
  .object({
    zoneId: z.string().uuid(),
    name: z.string().trim().min(1).max(128),
    type: rateType,
    amount: minorAmount,
    currency,
    freeOverAmount: minorAmount.nullable().optional(),
    weightMinGrams: grams.nullable().optional(),
    weightMaxGrams: grams.nullable().optional(),
  })
  .strict()
  .refine(freeOverHasThreshold, {
    message: "type 'free_over' requires freeOverAmount",
    path: ['freeOverAmount'],
  })
  .refine(bandIsOrdered, {
    message: 'weightMinGrams must be ≤ weightMaxGrams',
    path: ['weightMaxGrams'],
  });
export class CreateRateDto extends createZodDto(CreateRateSchema) {}

export const UpdateRateSchema = z
  .object({
    zoneId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(128).optional(),
    type: rateType.optional(),
    amount: minorAmount.optional(),
    currency: currency.optional(),
    freeOverAmount: minorAmount.nullable().optional(),
    weightMinGrams: grams.nullable().optional(),
    weightMaxGrams: grams.nullable().optional(),
  })
  .strict()
  .refine(freeOverHasThreshold, {
    message: "type 'free_over' requires freeOverAmount",
    path: ['freeOverAmount'],
  })
  .refine(bandIsOrdered, {
    message: 'weightMinGrams must be ≤ weightMaxGrams',
    path: ['weightMaxGrams'],
  });
export class UpdateRateDto extends createZodDto(UpdateRateSchema) {}
