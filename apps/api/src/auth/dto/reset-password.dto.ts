/**
 * Reset-password DTO.
 *
 * `token` is the exact base64url shape of a 32-byte CSPRNG token (43 chars).
 * `newPassword` enforces the min-12 / max-1024 policy; the offline
 * breached-password check runs in the service layer (no network egress).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ResetPasswordSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    newPassword: z.string().min(12).max(1024),
  })
  .strict();

export class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}
