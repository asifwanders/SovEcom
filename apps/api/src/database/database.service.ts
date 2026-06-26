import { Injectable, OnModuleDestroy } from '@nestjs/common';
import postgres from 'postgres';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

/** Default postgres.js pool size when `DB_POOL_MAX` is unset or invalid. */
const DEFAULT_DB_POOL_MAX = 10;

/**
 * Parse `DB_POOL_MAX` safely. `Number(undefined)` is NaN and a non-numeric value
 * yields NaN — both silently corrupt the pool sizing. Fall back to the default
 * on any missing / non-finite / non-positive value; otherwise floor to an int.
 */
export function resolveDbPoolMax(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_DB_POOL_MAX;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DB_POOL_MAX;
  }
  return Math.floor(parsed);
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly sql: postgres.Sql;
  readonly db: PostgresJsDatabase<typeof schema>;

  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set');
    }

    this.sql = postgres(url, { max: resolveDbPoolMax(process.env.DB_POOL_MAX) });
    this.db = drizzle(this.sql, { schema });
  }

  /**
   * The raw postgres.js client (pooled, authenticated as the app role). Exposed for low-level
   * needs Drizzle does not cover — specifically provisioning DDL (creating per-module
   * schemas/roles). Untrusted module SQL does NOT run here; it runs on a SEPARATE connection
   * authenticated as the unprivileged module role (see ModuleSqlExecutor). Prefer `db`
   * (Drizzle) for everything else.
   */
  get session(): postgres.Sql {
    return this.sql;
  }

  async ping(): Promise<boolean> {
    try {
      await this.sql`select 1`;
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
