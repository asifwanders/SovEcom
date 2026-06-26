/**
 * ConfirmEmailDto (AUTH/CREDENTIAL/PII-CRITICAL).
 *
 * The PUBLIC confirm body for a verify-before-switch email change. The single-use
 * verification token IS the credential (this endpoint carries no session), so the
 * schema only bounds it (the token is a 32-byte base64url string ≈ 43 chars; 512 is
 * a generous upper bound). `.strict()` rejects unknown keys.
 *
 * The token is NEVER logged.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ConfirmEmailSchema = z
  .object({
    token: z.string().min(1).max(512),
  })
  .strict();

export class ConfirmEmailDto extends createZodDto(ConfirmEmailSchema) {}
