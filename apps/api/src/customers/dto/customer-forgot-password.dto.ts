/**
 * CustomerForgotPasswordDto (AUTH/CREDENTIAL-CRITICAL).
 *
 * The UNAUTH forgot-password body for the storefront customer. Mirrors the admin
 * `ForgotPasswordDto`: the email is normalized to lower-case at the boundary (the
 * same form as storage + the per-destination throttle key). The endpoint ALWAYS
 * returns 202 regardless of whether the email exists, so this DTO never reveals
 * existence. `.strict()` rejects unknown keys (no mass-assignment).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CustomerForgotPasswordSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.string().email().max(254)),
  })
  .strict();

export class CustomerForgotPasswordDto extends createZodDto(CustomerForgotPasswordSchema) {}
