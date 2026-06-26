/**
 * UpdateCustomerDto (PATCH semantics; store /me + admin :id).
 *
 * Self-service customers and admins both patch the same mutable surface. NOT
 * patchable here: email (identity), password (separate flow), and every internal
 * column (vat_validated, totp_*, anonymized_at, metadata, tax_exempt, is_b2b) —
 * those are not customer-/admin-settable via this DTO. A `vatNumber` change
 * re-triggers VIES. `.strict` blocks mass-assignment.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UpdateCustomerSchema = z
  .object({
    name: z.string().min(1).max(255).nullable().optional(),
    phone: z.string().min(1).max(64).nullable().optional(),
    vatNumber: z.string().min(1).max(64).nullable().optional(),
    acceptsMarketing: z.boolean().optional(),
  })
  .strict();

export class UpdateCustomerDto extends createZodDto(UpdateCustomerSchema) {}
