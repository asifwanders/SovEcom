/**
 * AdminUpdateCustomerDto (admin PATCH /admin/v1/customers/:id).
 *
 * Superset of the self-service UpdateCustomerDto: an admin may additionally flip
 * `taxExempt` and `isB2b`. A `vatNumber` change re-triggers VIES (0025.5). Still
 * NOT settable: email, vat_validated, totp_*, metadata, anonymized_at. `.strict()`.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const AdminUpdateCustomerSchema = z
  .object({
    name: z.string().min(1).max(255).nullable().optional(),
    phone: z.string().min(1).max(64).nullable().optional(),
    vatNumber: z.string().min(1).max(64).nullable().optional(),
    isB2b: z.boolean().optional(),
    taxExempt: z.boolean().optional(),
    acceptsMarketing: z.boolean().optional(),
  })
  .strict();

export class AdminUpdateCustomerDto extends createZodDto(AdminUpdateCustomerSchema) {}
