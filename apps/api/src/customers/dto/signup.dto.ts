/**
 * SignupDto (store self-service customer registration).
 *
 * `password` enforces the same min-12 / max-1024 policy as admin; the offline
 * breached-password check runs in the service. `vatNumber` triggers a VIES check
 * when present but NEVER blocks signup on the outcome. `.strict()` rejects unknown
 * keys (no mass-assignment of internal columns).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const SignupSchema = z
  .object({
    email: z.string().email().max(320).toLowerCase(),
    password: z.string().min(12).max(1024),
    name: z.string().min(1).max(255).optional(),
    phone: z.string().min(1).max(64).optional(),
    isB2b: z.boolean().default(false),
    vatNumber: z.string().min(1).max(64).optional(),
    acceptsMarketing: z.boolean().default(false),
  })
  .strict();

export class SignupDto extends createZodDto(SignupSchema) {}
