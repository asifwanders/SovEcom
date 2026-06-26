/**
 * Login DTO.
 *
 * `.strict()` rejects unknown fields. Email is trimmed +
 * lower-cased at the boundary so storage, lookup and throttle keys share one
 * normalized form. Password length is bounded to cap Argon2 work (anti-DoS) but not its content.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const LoginSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.string().email().max(254)),
    password: z.string().min(1).max(1024),
  })
  .strict();

export class LoginDto extends createZodDto(LoginSchema) {}
