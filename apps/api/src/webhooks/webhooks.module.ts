/**
 * WebhooksModule.
 *
 * Outbound webhook delivery: a fan-out listener turns internal domain events into `webhook_deliveries`
 * outbox rows; a @Cron worker signs + POSTs them with SSRF-guarded, DNS-rebinding-proof delivery and
 * backoff/exhaust; admin manages subscriptions + the delivery log + retry.
 *
 * Imports: AuthModule (exported AeadService — encrypt/decrypt the signing secret at rest);
 * ScheduleModule.forRoot() (the @Cron worker — already root-registered elsewhere; duplicate is safe).
 * No cycle: nothing imports WebhooksModule.
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from '../auth/auth.module';
import { WebhookSubscriptionRepository } from './webhook-subscription.repository';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { WebhooksService } from './webhooks.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookEventListener } from './webhook-event.listener';
import { WebhookDeliveryWorker } from './webhook-delivery.worker';
import { WebhooksAdminController } from './webhooks.controller.admin';

@Module({
  imports: [AuthModule, ScheduleModule.forRoot()],
  providers: [
    WebhookSubscriptionRepository,
    WebhookDeliveryRepository,
    WebhooksService,
    WebhookDeliveryService,
    WebhookEventListener,
    WebhookDeliveryWorker,
  ],
  controllers: [WebhooksAdminController],
  exports: [WebhookDeliveryService],
})
export class WebhooksModule {}
