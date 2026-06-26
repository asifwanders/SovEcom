/**
 * OSS export query DTO.
 *
 * `from` / `to` are ISO-8601 date (or datetime) STRINGS — kept as strings (NOT
 * `z.coerce.date()` / `z.date()`, which break SwaggerModule JSON-schema generation,
 * the same rule the tax-settings DTOs follow). The controller parses them to Date and
 * normalises an all-day window. Both are required so the export always has bounds.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** Accept `YYYY-MM-DD` or a full ISO-8601 datetime; reject anything unparseable. */
const isoDate = z
  .string()
  .trim()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO-8601 date or datetime');

export const OssExportQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
  })
  .strict();

export class OssExportQueryDto extends createZodDto(OssExportQuerySchema) {}
