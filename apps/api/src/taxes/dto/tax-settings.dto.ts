/**
 * Tax-settings + tax-rate admin DTOs.
 *
 * nestjs-zod `createZodDto` with `.strict()`. NO `z.coerce.date()` / `z.date()`
 * (breaks SwaggerModule JSON-schema generation) — no date fields here anyway.
 * `rate` is the NUMERIC(5,4) string the DB stores (e.g. "0.2000").
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'country must be a 2-letter ISO 3166-1 alpha-2 code')
  .transform((s) => s.toUpperCase());

/** NUMERIC(5,4): 0.0000 .. 0.9999 inclusive (a fraction, not a percentage). */
const rateString = z
  .string()
  .regex(/^0(\.\d{1,4})?$/, 'rate must be a decimal fraction with up to 4 dp, e.g. "0.2000"')
  .refine((s) => {
    const n = Number(s);
    return n >= 0 && n < 1;
  }, 'rate must be ≥ 0 and < 1 (a fraction; 20% = "0.2000")');

// ── Tax settings (PUT /admin/v1/taxes/settings) ───────────────────────────────

export const UpdateTaxSettingsSchema = z
  .object({
    taxMode: z.enum(['none', 'eu_vat']).optional(),
    pricesIncludeTax: z.boolean().optional(),
    ossPosture: z.enum(['below_threshold', 'above_or_opted_in']).optional(),
    /** EU-VAT registration (only meaningful for `eu_vat`). */
    euVatRegistration: z
      .object({
        originCountry: country.nullable().optional(),
        vatNumber: z.string().trim().min(1).max(32).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export class UpdateTaxSettingsDto extends createZodDto(UpdateTaxSettingsSchema) {}

// ── Tax rate CRUD (/admin/v1/taxes/rates) ─────────────────────────────────────

export const CreateTaxRateSchema = z
  .object({
    country,
    region: z.string().trim().min(1).max(64).nullable().optional(),
    rate: rateString,
    name: z.string().trim().min(1).max(128),
  })
  .strict();

export class CreateTaxRateDto extends createZodDto(CreateTaxRateSchema) {}

export const UpdateTaxRateSchema = z
  .object({
    country: country.optional(),
    region: z.string().trim().min(1).max(64).nullable().optional(),
    rate: rateString.optional(),
    name: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

export class UpdateTaxRateDto extends createZodDto(UpdateTaxRateSchema) {}
