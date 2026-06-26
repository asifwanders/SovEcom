/**
 * CartFlushService (dirty-set + flush worker).
 *
 * Drains the per-tenant dirty set every ~5 s and upserts those carts to
 * Postgres in a batch. State lives in Redis so the worker survives process
 * restart. Operations are idempotent — re-flushing a clean cart is a no-op.
 *
 * Also runs a daily PG cleanup removing carts older than 30 days.
 *
 * Uses @nestjs/schedule `@Interval` and `@Cron` since that package is already
 * a dependency (verified in package.json).
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { CartFlushRepository } from './cart-flush.repository';

const FLUSH_INTERVAL_MS = 5_000;

@Injectable()
export class CartFlushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CartFlushService.name);
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(
    private readonly repo: CartFlushRepository,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    // Do NOT auto-fire the interval under tests: a 5 s background flush writing to
    // carts/cart_items while each test TRUNCATEs and reserves against the same
    // tables is a source of nondeterminism (and the flush path is covered by tests
    // calling flush() directly). The daily cleanup below uses @Cron from ScheduleModule.
    if (process.env.NODE_ENV === 'test') return;
    // A manual setInterval (not @Interval) so the handle can be cleared on destroy.
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Public so tests can call flush() synchronously without waiting for the
   * interval.
   */
  async flush(): Promise<void> {
    if (this.destroyed) return;
    try {
      // Discover tenants from the Redis dirty-set keys — NOT the Postgres carts
      // table, which is empty for carts that have never been flushed yet.
      const tenantIds = await this.repo.getDirtyTenantIds();
      for (const tenantId of tenantIds) {
        const count = await this.repo.flushDirty(tenantId);
        if (count > 0) {
          this.logger.debug(`flushed ${count} carts to Postgres for tenant ${tenantId}`);
        }
      }
    } catch (err) {
      this.logger.error('cart flush error', err instanceof Error ? err.stack : String(err));
    }
  }

  /** Daily cleanup job — removes Postgres carts older than 30 days. */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async dailyCleanup(): Promise<void> {
    if (this.destroyed) return;
    try {
      const tenantIds = await this.repo.getAllTenantIds();
      for (const tenantId of tenantIds) {
        const count = await this.repo.deleteExpiredCarts(tenantId);
        if (count > 0) {
          this.logger.log(`cleaned up ${count} expired carts for tenant ${tenantId}`);
        }
      }
    } catch (err) {
      this.logger.error('cart cleanup error', err instanceof Error ? err.stack : String(err));
    }
  }
}
