/**
 * webhook DTOs. nestjs-zod `.strict`.
 */
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { WEBHOOK_EVENTS, type WebhookEventName } from '../webhook.types';
import { deliveryStatusEnum } from '../../database/schema/_enums';

const webhookEvent = z.enum(WEBHOOK_EVENTS as unknown as [WebhookEventName, ...WebhookEventName[]]);
const deliveryStatus = z.enum(deliveryStatusEnum.enumValues as [string, ...string[]]);

export const CreateSubscriptionSchema = z
  .object({
    // The URL itself is SSRF-validated in the service (resolve + reject private); here we only
    // enforce a well-formed http(s) URL with a bounded length.
    url: z.string().url().max(2048),
    events: z.array(webhookEvent).min(1).max(WEBHOOK_EVENTS.length),
  })
  .strict();
export class CreateSubscriptionDto extends createZodDto(CreateSubscriptionSchema) {}

export const DeliveriesQuerySchema = z
  .object({
    subscriptionId: z.string().uuid().optional(),
    status: deliveryStatus.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(20),
  })
  .strict();
export class DeliveriesQueryDto extends createZodDto(DeliveriesQuerySchema) {}
