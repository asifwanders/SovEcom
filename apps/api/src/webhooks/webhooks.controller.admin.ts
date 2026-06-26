/**
 * Admin webhooks controller. Routes: /admin/v1/webhooks.
 *
 * Behind the GLOBAL admin JwtAuthGuard + PermissionsGuard. Webhooks are integration settings:
 * READ (list subs / delivery log) needs `settings:read`; WRITES (create/delete sub, retry delivery)
 * need `settings:write` and are @Audit-tagged. The create response carries the signing secret ONCE.
 * Tenant-scoped throughout.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { WebhooksService } from './webhooks.service';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { CreateSubscriptionDto, DeliveriesQueryDto } from './dto/webhook.dto';
import type { WebhookEventName, DeliveryStatus } from './webhook.types';

@ApiTags('Admin / Webhooks')
@Controller('admin/v1/webhooks')
export class WebhooksAdminController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly delivery: WebhookDeliveryService,
    private readonly deliveries: WebhookDeliveryRepository,
  ) {}

  @Post('subscriptions')
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('webhook.subscription.created')
  @ApiOperation({ summary: 'Create a subscription (returns the signing secret ONCE)' })
  createSubscription(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSubscriptionDto) {
    return this.webhooks.create(user.tenantId, {
      url: dto.url,
      events: dto.events as WebhookEventName[],
    });
  }

  @Get('subscriptions')
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @ApiOperation({ summary: 'List subscriptions (no secrets)' })
  listSubscriptions(@CurrentUser() user: AuthenticatedUser) {
    return this.webhooks.list(user.tenantId);
  }

  @Delete('subscriptions/:id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('webhook.subscription.deleted')
  @ApiOperation({ summary: 'Delete a subscription (cascades its delivery log)' })
  async deleteSubscription(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.webhooks.delete(user.tenantId, id);
  }

  @Get('deliveries')
  @RequirePermission(PERMISSIONS.SETTINGS_READ)
  @ApiOperation({ summary: 'Delivery log (filter by subscription/status, offset pagination)' })
  listDeliveries(@CurrentUser() user: AuthenticatedUser, @Query() query: DeliveriesQueryDto) {
    return this.deliveries.list(user.tenantId, {
      subscriptionId: query.subscriptionId,
      status: query.status as DeliveryStatus | undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Post('deliveries/:id/retry')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.SETTINGS_WRITE)
  @Audit('webhook.delivery.retried')
  @ApiOperation({ summary: 'Retry a failed/exhausted delivery (re-armed for the worker)' })
  async retryDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ retried: true }> {
    await this.delivery.retry(user.tenantId, id);
    return { retried: true };
  }
}
