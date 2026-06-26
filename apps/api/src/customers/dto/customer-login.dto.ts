/**
 * CustomerLoginDto (store self-service login).
 *
 * Mirrors the admin LoginDto shape. The service is enumeration-/timing-safe, so
 * the DTO only validates shape (a bad email format is a 400, distinct from the
 * uniform 401 of a wrong/unknown credential — that asymmetry is acceptable since
 * a malformed email is not an account-existence oracle).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const CustomerLoginSchema = z
  .object({
    email: z.string().email().max(320).toLowerCase(),
    password: z.string().min(1).max(1024),
  })
  .strict();

export class CustomerLoginDto extends createZodDto(CustomerLoginSchema) {}
