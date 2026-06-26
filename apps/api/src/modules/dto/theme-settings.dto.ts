/**
 * theme-settings PATCH validation.
 *
 * `PATCH /admin/v1/themes/:name/settings` carries a JSON `settings` object (colors/logo/fonts —
 * an opaque per-install bag). We bound it to a plain JSON object here; validation against the
 * theme's declared `settingsSchema` is deferred (the schema path is stored opaque).
 * This function does NOT decide what keys are allowed — it only guarantees a well-typed object
 * reaches the service.
 */
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** Hard cap on the serialized settings blob (defence against an oversized JSON body). */
const SETTINGS_MAX_BYTES = 32 * 1024;

/** A plain JSON object — content is opaque (the declared settingsSchema validates it later). */
const settingsSchema = z.record(z.string(), z.unknown());

/**
 * Coerce the PATCH `settings` field to a validated `Record<string, unknown>`.
 *   - absent / null → 400 (the PATCH must supply a settings object).
 *   - a JSON object → bounded + shape-checked.
 * Anything else (an array, a primitive, an oversized blob) → 400.
 */
export function parseThemeSettings(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    throw new BadRequestException('settings must be a JSON object');
  }
  // Reject arrays explicitly — `z.record` would accept array index keys otherwise.
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('settings must be a JSON object');
  }
  const byteLen = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  if (byteLen > SETTINGS_MAX_BYTES) {
    throw new BadRequestException(
      `settings too large: ${byteLen} bytes exceeds the ${SETTINGS_MAX_BYTES}-byte cap`,
    );
  }
  const result = settingsSchema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException('settings must be a JSON object');
  }
  return result.data;
}
