/**
 * DTOs for the admin stats endpoints.
 *
 * All validated with nestjs-zod (createZodDto + z), mirroring the orders module
 * convention.
 *
 * Date fields (`from`/`to`) are modeled as ISO date/date-time STRINGS at the API
 * boundary and parsed to a `Date` via `.transform` — NEVER `z.coerce.date()` / `z.date()`,
 * whose `ZodDate` output "cannot be represented in JSON Schema" and makes
 * `SwaggerModule.createDocument` throw (breaking the OpenAPI + Swagger-UI endpoints, and
 * the committed contract dump). Accepts the same lenient inputs as `coerce.date` — anything
 * `Date.parse` handles, incl. the frontend's `2026-06-01T00:00:00.000Z` and a bare
 * `2026-06-01`. The transform runs per-field BEFORE the object-level refines, so
 * `from`/`to` are already `Date`s when the range + bucket-cap checks (and downstream
 * service/repository) read them — no service change needed.
 *
 * Bucket-count cap: to guard against abuse (e.g. a 10-year daily range = 3650 rows),
 * we cap at MAX_BUCKETS. The caller gets a 400 if the range × granularity exceeds it.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const MAX_BUCKETS = 400;

/** ISO date/date-time string at the boundary → `Date` at runtime (Swagger-safe). */
const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'must be an ISO date' })
  .transform((s) => new Date(s));

const granularityEnum = z.enum(['day', 'week', 'month']);

/** Base date-range params shared by summary and timeseries. */
const DateRangeSchema = z
  .object({
    from: isoDate,
    to: isoDate,
  })
  .strict()
  .refine((d) => d.from <= d.to, { message: '`from` must be <= `to`' });

export const SummaryQuerySchema = DateRangeSchema;
export class SummaryQueryDto extends createZodDto(SummaryQuerySchema) {}

export const TimeseriesQuerySchema = DateRangeSchema.and(
  z
    .object({
      granularity: granularityEnum.default('day'),
    })
    .strict(),
).refine(
  (d) => {
    const msPerBucket: Record<string, number> = {
      day: 86_400_000,
      week: 7 * 86_400_000,
      month: 30 * 86_400_000,
    };
    const ms = d.to.getTime() - d.from.getTime();
    const buckets = Math.ceil(ms / msPerBucket[d.granularity]!) + 1;
    return buckets <= MAX_BUCKETS;
  },
  {
    message: `Range too wide: would exceed ${MAX_BUCKETS} buckets for the selected granularity`,
  },
);
export class TimeseriesQueryDto extends createZodDto(TimeseriesQuerySchema) {}

export const TopProductsQuerySchema = DateRangeSchema.and(
  z
    .object({
      limit: z.coerce.number().int().min(1).max(20).default(5),
      by: z.enum(['revenue', 'quantity']).default('revenue'),
    })
    .strict(),
);
export class TopProductsQueryDto extends createZodDto(TopProductsQuerySchema) {}
