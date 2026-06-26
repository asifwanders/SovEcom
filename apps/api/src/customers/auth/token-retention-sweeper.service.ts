/**
 * TokenRetentionSweeperService (AUTH/CREDENTIAL-CRITICAL).
 *
 * Steady-state retention sweep for ALL single-use credential tokens. Every day at
 * midnight it HARD-DELETES dead rows from all three token tables — `email_change_tokens`,
 * `password_reset_tokens`, and `customer_password_reset_tokens` — once they are no longer
 * usable past a retention grace.
 *
 * Predicate (uniform across all three tables): `expires_at < now() - INTERVAL '<grace>'`.
 * Because every token has a 1h TTL, a CONSUMED row is also expired shortly after it is
 * used, so this single expiry-based predicate sweeps BOTH consumed and expired-unconsumed
 * rows uniformly — there is no need to special-case `consumed_at`. The grace (default 7
 * days) keeps recently-dead rows around briefly for audit/debug correlation before purge.
 *
 * This is NOT correctness-critical: every consume path already re-checks `consumed_at IS
 * NULL AND expires_at > now()`, so a lagging sweeper never lets a dead token authorize
 * anything — it only reclaims rows. RGPD note: the on-REQUEST purge already exists (erase
 * hard-deletes a customer's email_change_tokens + reset tokens); this sweeper is the
 * steady-state retention sweep for ALL dead tokens regardless of subject.
 *
 * Mirrors InventorySweeperService: a guarded @Cron plus a public `sweep()` an integration
 * test can call synchronously. Token hashes are never logged (only counts).
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { lt, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { emailChangeTokens } from '../../database/schema/email_change_tokens';
import { passwordResetTokens } from '../../database/schema/password_reset_tokens';
import { customerPasswordResetTokens } from '../../database/schema/customer_password_reset_tokens';

/** Default retention grace past expiry before a dead token row is purged. */
const DEFAULT_RETENTION_DAYS = 7;
/** Clamp the configured grace into a sane range (avoid 0-day churn / absurd retention). */
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 90;

@Injectable()
export class TokenRetentionSweeperService implements OnModuleDestroy {
  private readonly logger = new Logger(TokenRetentionSweeperService.name);
  private destroyed = false;
  /** Read + clamped ONCE at construction (env is process-static for the app's life). */
  private readonly retentionDays: number;

  constructor(private readonly database: DatabaseService) {
    this.retentionDays = TokenRetentionSweeperService.resolveRetentionDays();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
  }

  /** Read `TOKEN_RETENTION_DAYS` (default 7), clamped to [MIN, MAX]. Never throws. */
  private static resolveRetentionDays(): number {
    const raw = Number.parseInt(process.env.TOKEN_RETENTION_DAYS ?? '', 10);
    if (!Number.isFinite(raw) || Number.isNaN(raw)) {
      return DEFAULT_RETENTION_DAYS;
    }
    return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, raw));
  }

  /** Cron entry point — every day at midnight. */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async run(): Promise<void> {
    if (this.destroyed) return;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error(
        'token retention sweep error',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Delete dead token rows from all three token tables past the retention grace.
   * Public so tests can drive it directly without waiting for the cron. Returns the
   * total number of rows reclaimed across all three tables.
   */
  async sweep(): Promise<number> {
    // A single expiry-based cutoff sweeps consumed + expired-unconsumed rows uniformly
    // (every token has a 1h TTL, so a consumed row is expired soon after). Parameterize
    // the grace as an INTERVAL of N days computed in SQL (`now() - make_interval(...)`)
    // so the cutoff is server-clock-relative, not app-clock-relative.
    const cutoff = sql`now() - make_interval(days => ${this.retentionDays})`;

    // Use the AFFECTED-ROW COUNT from the bare DELETE, NOT `.returning({ id }).length`:
    // a first-run backlog could be huge, and materializing every deleted id only to count
    // them is wasteful. A drizzle/postgres-js DELETE without `.returning()` resolves to a
    // RowList whose `.count` is the affected-row count (no rows materialized).
    const emailChangeCount = rowCount(
      await this.database.db
        .delete(emailChangeTokens)
        .where(lt(emailChangeTokens.expiresAt, cutoff)),
    );
    const adminResetCount = rowCount(
      await this.database.db
        .delete(passwordResetTokens)
        .where(lt(passwordResetTokens.expiresAt, cutoff)),
    );
    const customerResetCount = rowCount(
      await this.database.db
        .delete(customerPasswordResetTokens)
        .where(lt(customerPasswordResetTokens.expiresAt, cutoff)),
    );

    const total = emailChangeCount + adminResetCount + customerResetCount;
    if (total > 0) {
      this.logger.debug(
        `token retention sweep reclaimed ${total} dead token row(s) ` +
          `(email_change=${emailChangeCount}, ` +
          `password_reset=${adminResetCount}, ` +
          `customer_password_reset=${customerResetCount}; grace=${this.retentionDays}d)`,
      );
    }
    return total;
  }
}

/**
 * Read the affected-row count off a drizzle/postgres-js DELETE result. A bare DELETE
 * (no RETURNING) resolves to a postgres-js RowList carrying `.count` (the affected-row
 * count) without materializing any rows. Falls back to `.length` defensively.
 */
function rowCount(result: unknown): number {
  const r = result as { count?: number; length?: number };
  if (typeof r.count === 'number') return r.count;
  return typeof r.length === 'number' ? r.length : 0;
}
