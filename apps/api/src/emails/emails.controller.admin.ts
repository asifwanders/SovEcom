/**
 * Admin email-log controller. Routes: /admin/v1/emails.
 *
 * Behind the GLOBAL admin JwtAuthGuard + PermissionsGuard. LIST needs `orders:read` (staff+);
 * RESEND needs `orders:write` (admin+) and is @Audit-tagged. Reuses the orders permissions
 * (emails are order/refund-related — avoids permission sprawl). Tenant-scoped.
 */
import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { EmailNotificationService } from './email-notification.service';
import { EmailLogRepository } from './email-log.repository';
import { EmailLogsQueryDto } from './dto/email.dto';
import type { EmailStatus, EmailType } from './email.types';

@ApiTags('Admin / Emails')
@Controller('admin/v1/emails')
export class EmailsAdminController {
  constructor(
    private readonly logs: EmailLogRepository,
    private readonly emails: EmailNotificationService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.ORDERS_READ)
  @ApiOperation({
    summary: 'Email send log (offset pagination; optional status/type/order filters)',
  })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: EmailLogsQueryDto) {
    return this.logs.list(user.tenantId, {
      status: query.status as EmailStatus | undefined,
      type: query.type as EmailType | undefined,
      orderId: query.orderId,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Post(':id/resend')
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.ORDERS_WRITE)
  @Audit('email.resent')
  @ApiOperation({ summary: 'Re-render and resend a logged email (writes a fresh log row)' })
  resend(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.emails.resend(user.tenantId, id);
  }
}
