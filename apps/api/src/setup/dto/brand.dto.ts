/**
 * brand step DTO.
 *
 * The brand step is `multipart/form-data` (the logo is a binary part), so the scalar
 * fields arrive as STRINGS. This schema coerces them: hex colours are validated, and
 * `gradient` is coerced from the string `"true"`/`"false"` a form sends. The logo file
 * itself is validated in the service (content-type + size) — it is not in this body
 * schema. All fields are optional so a store can set just a logo, or just colours.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A CSS hex colour, e.g. `#1a2b3c` or `#abc`. */
const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'colour must be a hex value like #1a2b3c');

/** Coerce a multipart string boolean ("true"/"false"/"1"/"0") to a real boolean. */
const formBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const BrandConfigureSchema = z
  .object({
    primary: hexColor.optional(),
    secondary: hexColor.optional(),
    gradient: formBool.optional(),
  })
  .strict();

export class BrandConfigureDto extends createZodDto(BrandConfigureSchema) {}
