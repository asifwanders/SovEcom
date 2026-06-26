/**
 * Cart DTOs.
 *
 * All inputs use nestjs-zod `createZodDto` with `.strict()`. Dates are ISO
 * strings + `.transform(s => new Date(s))` — NEVER `z.coerce.date()` / `z.date()`
 * (breaks SwaggerModule JSON-schema generation note).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// ── Address sub-schema (shared for shipping + billing) ────────────────────────

const AddressSchema = z
  .object({
    name: z.string().min(1).max(255),
    company: z.string().min(1).max(255).optional().nullable(),
    line1: z.string().min(1).max(512),
    line2: z.string().min(1).max(512).optional().nullable(),
    city: z.string().min(1).max(255),
    postalCode: z.string().min(1).max(32),
    region: z.string().min(1).max(255).optional().nullable(),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/, 'country must be a 2-letter ISO-3166 code')
      .toUpperCase(),
    phone: z.string().min(1).max(64).optional().nullable(),
  })
  .strict();

// ── Create cart ───────────────────────────────────────────────────────────────

export const CreateCartSchema = z
  .object({
    /** Optional currency override; defaults to the tenant default (EUR). */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code')
      .optional(),
  })
  .strict();

export class CreateCartDto extends createZodDto(CreateCartSchema) {}

// ── Add item ──────────────────────────────────────────────────────────────────

/** Per-line quantity ceiling. Bounds money math well within Number.MAX_SAFE_INTEGER
 *  (10k × any sane unit price) and is a boundary backstop to the stock check. */
const MAX_LINE_QUANTITY = 10_000;

export const AddCartItemSchema = z
  .object({
    variantId: z.string().uuid(),
    quantity: z.number().int().positive().max(MAX_LINE_QUANTITY),
  })
  .strict();

export class AddCartItemDto extends createZodDto(AddCartItemSchema) {}

// ── Update item ───────────────────────────────────────────────────────────────

export const UpdateCartItemSchema = z
  .object({
    quantity: z.number().int().positive().max(MAX_LINE_QUANTITY),
  })
  .strict();

export class UpdateCartItemDto extends createZodDto(UpdateCartItemSchema) {}

// ── Set address ───────────────────────────────────────────────────────────────

export const SetAddressSchema = AddressSchema;
export class SetAddressDto extends createZodDto(SetAddressSchema) {}

// ── Set shipping method ───────────────────────────────────────────────────────

export const SetShippingMethodSchema = z
  .object({
    shippingRateId: z.string().uuid(),
  })
  .strict();

export class SetShippingMethodDto extends createZodDto(SetShippingMethodSchema) {}

// ── Set guest email ───────────────────────────────────────────────────────────

export const SetGuestEmailSchema = z
  .object({
    email: z.string().email().max(320).toLowerCase(),
  })
  .strict();

export class SetGuestEmailDto extends createZodDto(SetGuestEmailSchema) {}
