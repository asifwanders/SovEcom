/**
 * tax/configure step DTO — onboarding profile.
 *
 * The wizard's onboarding moment: `businessCountry` (ISO 3166-1 α-2) + `defaultCurrency`
 * (ISO 4217) form the profile; `taxMode`/`vatNumber`/`ossPosture`/ `pricesIncludeTax`
 * configure the tax regime. `taxMode` is OPTIONAL — when omitted the service defaults it
 * from the business country (EU→`eu_vat`, else `none`). The EU guardrail (shared with
 * the admin controller) is enforced server-side, not here.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** ISO 3166-1 alpha-2 country, normalised to upper-case. */
const country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'businessCountry must be a 2-letter ISO 3166-1 alpha-2 code')
  .transform((s) => s.toUpperCase());

/** ISO 4217 currency code, normalised to upper-case. */
const currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'defaultCurrency must be a 3-letter ISO 4217 code')
  .transform((s) => s.toUpperCase());

export const TaxConfigureSchema = z
  .object({
    businessCountry: country,
    defaultCurrency: currency,
    /** Omit to default from businessCountry (EU→eu_vat, else none). */
    taxMode: z.enum(['none', 'eu_vat']).optional(),
    /** Merchant's own VAT number (required by the guardrail for eu_vat). */
    vatNumber: z.string().trim().min(1).max(32).optional(),
    ossPosture: z.enum(['below_threshold', 'above_or_opted_in']).optional(),
    pricesIncludeTax: z.boolean().optional(),
  })
  .strict();

export class TaxConfigureDto extends createZodDto(TaxConfigureSchema) {}
