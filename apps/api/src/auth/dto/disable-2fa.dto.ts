/**
 * 2FA disable DTO.
 *
 * Disabling 2FA requires BOTH factors: the account password AND a fresh TOTP
 * code. A stolen access token alone cannot strip the second factor.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const Disable2faSchema = z
  .object({
    password: z.string().min(1).max(1024),
    totpCode: z.string().regex(/^\d{6}$/),
  })
  .strict();

export class Disable2faDto extends createZodDto(Disable2faSchema) {}
