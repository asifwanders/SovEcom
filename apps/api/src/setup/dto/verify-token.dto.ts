/**
 * VerifyTokenDto.
 *
 * Body shape for `POST /setup/v1/verify-token`.
 * Only validates that a non-empty string token is present (bounded length to
 * reject oversized payloads). The service returns a uniform `{ valid, expiresAt }`
 * — a malformed token is `valid:false`, indistinguishable from a wrong one.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const VerifyTokenSchema = z
  .object({
    token: z.string().min(1).max(512),
  })
  .strict();

export class VerifyTokenDto extends createZodDto(VerifyTokenSchema) {}
