/**
 * slot-resolution-request validation.
 *
 * The body of `PUT /admin/v1/slots/:slot/resolution` carries the admin's chosen winner: a
 * single `module` slug. Validated at the boundary with Zod
 * to a bounded lowercase-slug string. This function only guarantees a well-typed module NAME
 * reaches the service — the service then checks the module is actually an enabled candidate for
 * the slot (404 / 422). A malformed/absent value is a 400.
 */
import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** A module slug — same shape as `module-manifest`'s NAME_RE, bounded. */
const moduleNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'module must be a lowercase slug');

/**
 * A slot slug — same shape + bound as `module-manifest`'s SLOT_RE / MAX_SLOT_LEN (lowercase
 * slug, ≤128). The `:slot` path param is bounded here at the boundary even though the service's
 * candidate-match gate already prevents any non-slug slot from ever being persisted — defence in
 * depth.
 */
const slotNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9-]*$/, 'slot must be a lowercase slug');

/** Coerce the request body's `module` field to a validated slug, or 400. */
export function parseSlotResolution(raw: unknown): string {
  const result = moduleNameSchema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException('module must be a lowercase module-name slug');
  }
  return result.data;
}

/** Coerce the `:slot` path param to a validated bounded slug, or 400. */
export function parseSlotName(raw: unknown): string {
  const result = slotNameSchema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException('slot must be a lowercase slug');
  }
  return result.data;
}
