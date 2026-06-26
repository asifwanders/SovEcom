/**
 * AuditQueryDto.
 *
 * Query parameters for GET /admin/v1/audit-log. All params are optional;
 * pagination is clamped (never 500 on garbage). Uses nestjs-zod `.strict()`
 * (extra keys → 400).
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const MAX_PAGE_SIZE = 200;
/** Bound OFFSET depth so a hostile `?page=99999999` can't force a deep scan (#9). */
const MAX_PAGE = 10_000;

/**
 * ISO date / date-time string at the API boundary, parsed to a `Date` at runtime.
 * Modeled as a STRING (not `z.coerce.date()`, whose `ZodDate` output "cannot be
 * represented in JSON Schema" and makes `SwaggerModule.createDocument` throw,
 * breaking the OpenAPI + Swagger UI endpoints). Accepts the same lenient inputs as
 * `coerce.date` (anything `Date.parse` handles, incl. `2026-06-10`).
 */
const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'must be an ISO date' })
  .transform((s) => new Date(s));

/** A bare calendar date `YYYY-MM-DD` (no time component) — parsed as UTC midnight. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Upper-bound (`dateTo`) variant of {@link isoDate}. The range filter is
 * INCLUSIVE (`lte(createdAt, dateTo)`), so a date-only bound like `2026-06-10` must cover
 * the WHOLE day — otherwise it parses to that day's 00:00 UTC and `lte` silently drops
 * every same-day event after midnight (a COMPLIANCE-log truncation). A date-only input is
 * therefore normalised to the END of that UTC day (23:59:59.999); a FULL timestamp
 * (anything carrying a time, e.g. `2026-06-10T09:30:00Z`) is preserved EXACTLY as given so
 * a precise upper bound still works. `dateFrom` keeps plain {@link isoDate}: a date-only
 * lower bound at 00:00 is already the correct inclusive start of the day.
 */
const isoDateUpperBound = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'must be an ISO date' })
  .transform((s) => {
    if (DATE_ONLY_RE.test(s)) {
      // End of that calendar day in UTC, inclusive of every same-day event.
      return new Date(`${s}T23:59:59.999Z`);
    }
    return new Date(s);
  });

export const AuditQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
    actorId: z.string().uuid().optional(),
    resourceType: z.string().min(1).max(128).optional(),
    resourceId: z.string().uuid().optional(),
    action: z.string().min(1).max(256).optional(),
    dateFrom: isoDate.optional(),
    dateTo: isoDateUpperBound.optional(),
  })
  .strict();

export type AuditQueryParams = z.infer<typeof AuditQuerySchema>;

export class AuditQueryDto extends createZodDto(AuditQuerySchema) {}

/** Maximum allowed date range for CSV export (31 days). */
export const EXPORT_MAX_RANGE_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPORT_MAX_RANGE_MS = EXPORT_MAX_RANGE_DAYS * DAY_MS;

/**
 * Export query. The export MUST always be bounded to a
 * ≤31-day window. To make the bound un-bypassable (#2):
 *   - at least one of dateFrom / dateTo is required, AND
 *   - whichever bound is MISSING is DERIVED (dateTo = dateFrom + 31d, or
 *     dateFrom = dateTo − 31d), AND
 *   - when BOTH are given the ≤31-day cap is enforced.
 * After `transform` both `dateFrom` and `dateTo` are always present, so a
 * single-date request like `?dateFrom=1970-01-01` can never export the whole
 * log — it is clamped to a 31-day window starting at that date.
 */
export const AuditExportQuerySchema = z
  .object({
    actorId: z.string().uuid().optional(),
    resourceType: z.string().min(1).max(128).optional(),
    resourceId: z.string().uuid().optional(),
    action: z.string().min(1).max(256).optional(),
    dateFrom: isoDate.optional(),
    dateTo: isoDateUpperBound.optional(),
  })
  .strict()
  .refine((data) => data.dateFrom !== undefined || data.dateTo !== undefined, {
    message: 'Export requires at least a dateFrom or dateTo to bound the result set',
  })
  .refine(
    (data) => {
      if (data.dateFrom && data.dateTo) {
        // a date-only `dateTo` is normalised to END-of-day (23:59:59.999) so the
        // inclusive filter covers the whole day. That widens the measured span by up to
        // (strictly under) one day, so the cap allows that much slack — a picker range
        // like 2024-01-01..2024-02-01 ("31 days" to the operator, inclusive of Feb 1)
        // still passes, while a full-timestamp range can exceed 31 days by at most that
        // sub-day amount. The per-row EXPORT_ROW_CAP is the hard density guard regardless.
        return data.dateTo.getTime() - data.dateFrom.getTime() < EXPORT_MAX_RANGE_MS + DAY_MS;
      }
      return true;
    },
    {
      message: `Export date range must not exceed ${EXPORT_MAX_RANGE_DAYS} days`,
    },
  )
  .transform((data) => {
    // Derive the missing bound so the export window is ALWAYS ≤31 days and never
    // open-ended. At least one bound is guaranteed present by the refine above.
    let { dateFrom, dateTo } = data;
    if (dateFrom && !dateTo) {
      dateTo = new Date(dateFrom.getTime() + EXPORT_MAX_RANGE_MS);
    } else if (!dateFrom && dateTo) {
      dateFrom = new Date(dateTo.getTime() - EXPORT_MAX_RANGE_MS);
    }
    return { ...data, dateFrom, dateTo };
  });

export type AuditExportQueryParams = z.infer<typeof AuditExportQuerySchema>;

export class AuditExportQueryDto extends createZodDto(AuditExportQuerySchema) {}
