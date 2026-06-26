/**
 * AdminCreateCustomerDto (admin POST /admin/v1/customers).
 *
 * Admins may create a customer with a wider surface than self-signup, including
 * `taxExempt` (a tax decision an admin owns). `password` is OPTIONAL — an admin
 * can create a passwordless customer record (e.g. an imported B2B contact) who
 * later sets a password. A `vatNumber` triggers VIES (non-blocking).
 * `.strict()` blocks mass-assignment of internal columns (vat_validated, totp_*,
 * metadata, anonymized_at) — those are never client-settable.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const AdminCreateCustomerSchema = z
  .object({
    email: z.string().email().max(320).toLowerCase(),
    password: z.string().min(12).max(1024).optional(),
    name: z.string().min(1).max(255).optional(),
    phone: z.string().min(1).max(64).optional(),
    isB2b: z.boolean().default(false),
    vatNumber: z.string().min(1).max(64).optional(),
    taxExempt: z.boolean().default(false),
    acceptsMarketing: z.boolean().default(false),
  })
  .strict();

export class AdminCreateCustomerDto extends createZodDto(AdminCreateCustomerSchema) {}
