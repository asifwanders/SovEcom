/**
 * StoreQueryDto (/ Fable).
 *
 * Public store endpoints must never 500 on bad input. This schema:
 *   - clamps pageSize to 1..100 (NaN / missing → default 20),
 *   - validates the cursor decodes to { createdAt: ISO, id: uuid }; an invalid
 *     or garbage cursor is silently dropped (treated as "first page"), never an
 *     error that reaches Postgres.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Decode + validate an opaque base64 cursor; return undefined if malformed. */
function sanitizeCursor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as unknown;
    const shape = z.object({
      createdAt: z.string().datetime(),
      id: z.string().uuid(),
    });
    const parsed = shape.safeParse(decoded);
    if (!parsed.success) return undefined;
    // Re-validate the date is real (datetime() already checks ISO format).
    if (Number.isNaN(new Date(parsed.data.createdAt).getTime())) return undefined;
    return raw; // keep the original opaque string; the repo decodes it again
  } catch {
    return undefined;
  }
}

export const StoreQuerySchema = z
  .object({
    cursor: z
      .string()
      .optional()
      .transform((v) => sanitizeCursor(v)),
    pageSize: z.coerce.number().int().min(1).max(100).catch(20).default(20),
  })
  .strict();

export class StoreQueryDto extends createZodDto(StoreQuerySchema) {}
