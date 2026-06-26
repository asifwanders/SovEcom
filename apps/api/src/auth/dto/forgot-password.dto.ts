/**
 * forgot-password DTO.
 *
 * Email normalised at the boundary (same form as storage + the throttle key).
 * The endpoint ALWAYS returns 202 regardless of whether the email exists, so
 * this DTO never reveals existence.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const ForgotPasswordSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.string().email().max(254)),
  })
  .strict();

export class ForgotPasswordDto extends createZodDto(ForgotPasswordSchema) {}
