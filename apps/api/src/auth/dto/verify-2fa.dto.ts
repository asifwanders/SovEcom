/**
 * 2FA challenge verification DTO.
 *
 * `challengeId` is the opaque base64url id from {@link ChallengeService} (32 raw
 * bytes -> 43 base64url chars), NOT a JWT. `totpCode` is exactly six digits.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const Verify2faSchema = z
  .object({
    challengeId: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/),
    totpCode: z.string().regex(/^\d{6}$/),
  })
  .strict();

export class Verify2faDto extends createZodDto(Verify2faSchema) {}
