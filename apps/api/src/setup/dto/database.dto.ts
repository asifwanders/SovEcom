/**
 * database step DTOs.
 *
 * `DatabaseTestDto` validates a Postgres connection URL the operator wants to probe.
 * `DatabaseConfigureDto` records the operator's deployment choice (bare-metal vs an
 * external DB) — `url` is only meaningful (and required) for `external`. All bounds are
 * tight to reject oversized/garbage payloads at the boundary.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A Postgres connection string. Bounded; must look like a postgres URL. */
const PostgresUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => /^postgres(ql)?:\/\//i.test(v), {
    message: 'must be a postgres:// or postgresql:// URL',
  });

export const DatabaseTestSchema = z
  .object({
    url: PostgresUrl,
  })
  .strict();

export class DatabaseTestDto extends createZodDto(DatabaseTestSchema) {}

export const DatabaseConfigureSchema = z
  .object({
    mode: z.enum(['bare_metal', 'external']),
    url: PostgresUrl.optional(),
  })
  .strict()
  .refine((v) => v.mode !== 'external' || typeof v.url === 'string', {
    message: 'url is required when mode is external',
    path: ['url'],
  });

export class DatabaseConfigureDto extends createZodDto(DatabaseConfigureSchema) {}
