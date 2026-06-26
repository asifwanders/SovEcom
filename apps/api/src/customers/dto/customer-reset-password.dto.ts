/**
 * CustomerResetPasswordDto (AUTH/CREDENTIAL-CRITICAL).
 *
 * The UNAUTH reset body for the storefront customer. Mirrors the admin
 * `ResetPasswordDto`: `token` is the exact base64url shape of a 32-byte CSPRNG token
 * (43 chars), and `newPassword` enforces the SAME min-12 / max-1024 policy as signup
 * / admin reset. The offline breached-password denylist runs in the SERVICE (no
 * network egress), NOT the schema — so a 12+ char common password parses here and is
 * rejected downstream. `.strict()` rejects unknown keys (no mass-assignment).
 *
 * The password is NEVER logged.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CustomerResetPasswordSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    newPassword: z.string().min(12).max(1024),
  })
  .strict();

export class CustomerResetPasswordDto extends createZodDto(CustomerResetPasswordSchema) {}
