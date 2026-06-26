/**
 * the delivery worker. A guarded @Cron (every 30s) that drains due
 * deliveries via the transactional outbox. Overlap-guarded like the inventory/cart sweepers so a
 * slow run never stacks. `processDue` is public on the service for direct test invocation.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WebhookDeliveryService } from './webhook-delivery.service';

@Injectable()
export class WebhookDeliveryWorker {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);
  private running = false;

  constructor(private readonly delivery: WebhookDeliveryService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async tick(): Promise<void> {
    // In tests the worker is driven directly via `processDue()`; don't let the timer add background
    // transactions that contend with other suites (flakiness). No effect in dev/prod.
    if (process.env.NODE_ENV === 'test') return;
    if (this.running) return; // no overlap
    this.running = true;
    try {
      await this.delivery.processDue();
    } catch (err) {
      this.logger.error(
        `webhook delivery tick failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }
}
