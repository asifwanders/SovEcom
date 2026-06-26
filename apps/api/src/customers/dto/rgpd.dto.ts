/**
 * RGPD step-up DTOs (ruling A / B, SECURITY-CRITICAL).
 *
 * Both self-service RGPD endpoints now require the customer's CURRENT password in
 * the body so they are step-up-protected (export became a POST for this reason).
 * The admin erase requires a `confirmEmail` echo. `.strict()` blocks extra keys.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Self-service step-up: the caller re-enters their current password. */
export const RgpdStepUpSchema = z
  .object({
    password: z.string().min(1).max(1024),
  })
  .strict();

export class RgpdStepUpDto extends createZodDto(RgpdStepUpSchema) {}

/** Admin erase confirmation echo: must equal the target's current email. */
export const AdminEraseSchema = z
  .object({
    confirmEmail: z.string().email().max(320).toLowerCase(),
  })
  .strict();

export class AdminEraseDto extends createZodDto(AdminEraseSchema) {}
