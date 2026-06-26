/**
 * admin-account step DTOs (SECURITY-CRITICAL).
 *
 * The two-step email-OTP owner-credential flow:
 *   - `AdminAccountStartDto` {email, name}: who the owner is + where to send the OTP.
 *   - `AdminAccountVerifyDto` {email, otp, password}: the OTP proof + the new password.
 *
 * Bounds are tight (reject oversized/garbage at the boundary). The OTP is a 6-digit
 * numeric code (the only shape the service generates). The password mirrors the auth
 * policy (min-12; the breached-password denylist + Argon2id run in the service). The
 * email is validated + length-bounded; the service lower-cases it before any compare /
 * persist. NONE of these fields (otp/password) is ever logged or echoed.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const AdminAccountStartSchema = z
  .object({
    email: z.string().email().max(320),
    name: z.string().min(1).max(255),
  })
  .strict();

export class AdminAccountStartDto extends createZodDto(AdminAccountStartSchema) {}

export const AdminAccountVerifySchema = z
  .object({
    email: z.string().email().max(320),
    /** Exactly 6 numeric digits (the only OTP shape the service issues). */
    otp: z.string().regex(/^\d{6}$/, 'otp must be a 6-digit code'),
    /** Owner password — same min-12 policy as the auth reset flow. */
    password: z.string().min(12).max(1024),
  })
  .strict();

export class AdminAccountVerifyDto extends createZodDto(AdminAccountVerifySchema) {}
