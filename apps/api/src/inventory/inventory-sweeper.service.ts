/**
 * InventorySweeperService.
 *
 * Every 5 minutes, deletes expired `status='reserved'` reservation rows. This is
 * pure housekeeping — NOT correctness-critical: the availability query in
 * InventoryService already excludes expired reservations (`expires_at > now()`),
 * so a lagging sweeper never causes oversell, it only reclaims dead rows.
 *
 * Mirrors CartFlushService: a guarded @Cron plus a public sweep() the
 * integration test can call synchronously. No external job queue.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InventoryService } from './inventory.service';

@Injectable()
export class InventorySweeperService implements OnModuleDestroy {
  private readonly logger = new Logger(InventorySweeperService.name);
  private destroyed = false;

  constructor(private readonly inventory: InventoryService) {}

  onModuleDestroy(): void {
    this.destroyed = true;
  }

  /** Cron entry point — every 5 minutes. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async run(): Promise<void> {
    if (this.destroyed) return;
    try {
      await this.sweep();
    } catch (err) {
      this.logger.error('inventory sweep error', err instanceof Error ? err.stack : String(err));
    }
  }

  /**
   * Delete expired reserved rows. Public so tests can drive it directly without
   * waiting for the cron. Returns the number of rows reclaimed.
   */
  async sweep(): Promise<number> {
    const count = await this.inventory.deleteExpired();
    if (count > 0) {
      this.logger.debug(`swept ${count} expired reservation(s)`);
    }
    return count;
  }
}
