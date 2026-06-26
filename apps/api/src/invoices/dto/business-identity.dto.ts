/**
 * Business identity admin DTO. The PUT /admin/v1/business-identity body.
 *
 * This data prints on INVOICES (legal mentions, SIREN/SIRET, VAT). It is money/legal-
 * sensitive, so it is validated STRICTLY at the boundary:
 *  - an address, when provided, MUST carry line1 / city / country (a printable minimum);
 *  - country + origin_country are 2-letter ISO-3166 alpha-2, normalised upper-case;
 *  - free-text fields (name, siren, vatNumber, address parts) are length-bounded and
 *    reject markup-breaking characters (`<>"\``) — they are rendered into the invoice PDF.
 *
 * nestjs-zod `createZodDto` + `.strict()` (mirrors tax-settings.dto.ts). No date fields
 * (z.date breaks Swagger schema generation). `null` clears a field; absent leaves it.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A printable free-text field: trimmed, bounded, no markup-breaking chars. */
const printable = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[<>"`]/.test(s), 'must not contain < > " or ` characters');

/** ISO 3166-1 alpha-2 country code, normalised to upper-case. */
const country = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{2}$/, 'country must be a 2-letter ISO 3166-1 alpha-2 code')
  .transform((s) => s.toUpperCase());

/** Seller postal address. line1/city/country are REQUIRED when an address is provided. */
const AddressSchema = z
  .object({
    name: printable(128).nullable().optional(),
    company: printable(128).nullable().optional(),
    line1: printable(180).min(1),
    line2: printable(180).nullable().optional(),
    city: printable(120).min(1),
    postalCode: printable(20).nullable().optional(),
    country,
  })
  .strict();

export const UpdateBusinessIdentitySchema = z
  .object({
    name: printable(180).nullable().optional(),
    /** SIREN/SIRET (FR) — digits/spaces in practice; bounded + markup-safe. */
    siren: printable(32).nullable().optional(),
    /** `null` clears the whole address; a record replaces it. */
    address: AddressSchema.nullable().optional(),
    /** EU-VAT registration (origin country of establishment + the merchant VAT number). */
    originCountry: country.nullable().optional(),
    vatNumber: printable(32).nullable().optional(),
  })
  .strict();

export class UpdateBusinessIdentityDto extends createZodDto(UpdateBusinessIdentitySchema) {}
