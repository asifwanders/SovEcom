/**
 * 2FA confirm DTO. The six-digit TOTP code that proves
 * the user can produce codes from the pending secret before it is activated.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const Confirm2faSchema = z
  .object({
    totpCode: z.string().regex(/^\d{6}$/),
  })
  .strict();

export class Confirm2faDto extends createZodDto(Confirm2faSchema) {}
