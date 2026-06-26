/**
 * ChangeEmailDto (AUTH/CREDENTIAL/PII-CRITICAL).
 *
 * The authenticated customer's INITIATE body for a verify-before-switch email
 * change. `newEmail` is validated + normalized to lower-case at the boundary (RFC
 * 5321 caps the address at 320 chars); `currentPassword` is the step-up proof,
 * re-verified server-side with argon2id so the schema just bounds it. `.strict()`
 * rejects unknown keys (no mass-assignment of internal columns).
 *
 * The password is NEVER logged.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ChangeEmailSchema = z
  .object({
    newEmail: z.string().email().max(320).toLowerCase(),
    currentPassword: z.string().min(1).max(1024),
  })
  .strict();

export class ChangeEmailDto extends createZodDto(ChangeEmailSchema) {}
