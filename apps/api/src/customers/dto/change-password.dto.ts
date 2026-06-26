/**
 * ChangePasswordDto (AUTH/CREDENTIAL-CRITICAL).
 *
 * The authenticated customer's self-service password change body. `newPassword`
 * enforces the SAME min-12 / max-1024 length policy as signup; the offline
 * breached-password denylist check runs in the service (mirroring the signup +
 * admin reset flow), so the schema does not duplicate the wordlist. `currentPassword`
 * is only re-validated server-side (verified with argon2id), so the schema just
 * bounds it. `.strict()` rejects unknown keys (no mass-assignment).
 *
 * The password is NEVER logged.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newPassword: z.string().min(12).max(1024),
  })
  .strict();

export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
