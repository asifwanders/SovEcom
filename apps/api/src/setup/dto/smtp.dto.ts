/**
 * SMTP step DTOs.
 *
 * `SmtpTestDto` carries the full submitted credentials PLUS a `to` recipient for the
 * live test send (a throwaway transport — never the live MailService singleton).
 * `SmtpConfigureDto` is the persisted shape (no `to`): it is AEAD-encrypted into
 * `tenant_secrets` under kind `smtp`. All fields are bounded; the credentials are
 * never logged or echoed in any response.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Shared SMTP credential fields (the persisted blob shape). */
const SmtpCredsShape = {
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  /** Optional auth (IP-allowlisted relays may omit both). */
  user: z.string().max(255).optional(),
  pass: z.string().max(1024).optional(),
  from: z.string().min(3).max(320),
} as const;

export const SmtpTestSchema = z
  .object({
    ...SmtpCredsShape,
    to: z.string().email().max(320),
  })
  .strict();

export class SmtpTestDto extends createZodDto(SmtpTestSchema) {}

export const SmtpConfigureSchema = z.object(SmtpCredsShape).strict();

export class SmtpConfigureDto extends createZodDto(SmtpConfigureSchema) {}
