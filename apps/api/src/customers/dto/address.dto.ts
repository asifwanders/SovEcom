/**
 * Address DTOs (store self-service /me/addresses).
 *
 * `country` is ISO 3166-1 alpha-2 (exactly 2 ASCII letters) to satisfy the
 * `customer_addresses_country_chk` CHECK. `type` is the `address_type` enum
 * (shipping | billing). On create, `isDefault` makes this the default for its
 * type. `.strict()` blocks mass-assignment (customer_id/tenant_id are never
 * client-supplied — they come from the authenticated principal).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CreateAddressSchema = z
  .object({
    type: z.enum(['shipping', 'billing']),
    isDefault: z.boolean().default(false),
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

export class CreateAddressDto extends createZodDto(CreateAddressSchema) {}

export const UpdateAddressSchema = z
  .object({
    type: z.enum(['shipping', 'billing']).optional(),
    isDefault: z.boolean().optional(),
    name: z.string().min(1).max(255).optional(),
    company: z.string().min(1).max(255).optional().nullable(),
    line1: z.string().min(1).max(512).optional(),
    line2: z.string().min(1).max(512).optional().nullable(),
    city: z.string().min(1).max(255).optional(),
    postalCode: z.string().min(1).max(32).optional(),
    region: z.string().min(1).max(255).optional().nullable(),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/, 'country must be a 2-letter ISO-3166 code')
      .toUpperCase()
      .optional(),
    phone: z.string().min(1).max(64).optional().nullable(),
  })
  .strict();

export class UpdateAddressDto extends createZodDto(UpdateAddressSchema) {}
