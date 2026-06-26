/**
 * Admin Audit Log Controller.
 *
 * Routes:
 *   GET  /admin/v1/audit-log          — paginated query (AUDIT_LOG_READ)
 *   GET  /admin/v1/audit-log/export   — CSV export (AUDIT_LOG_EXPORT)
 *
 * Both routes are read-only (NO update or delete endpoints).
 * Tenant isolation is enforced via req.user.tenantId from the DB-sourced principal.
 *
 * The read query is NOT itself audited (operational, frequent).
 * The export IS audited (audit_log.exported) and records the
 * filter params + row count in changes.
 */
import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../authorization/permissions.constants';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/authenticated-user';
import { AuditQueryService } from '../audit-query.service';
import { AuditService } from '../audit.service';
import { AuditQueryDto, AuditExportQueryDto } from '../dto/audit-query.dto';

@ApiTags('Admin / Audit Log')
@Controller('admin/v1/audit-log')
export class AuditAdminController {
  constructor(
    private readonly queryService: AuditQueryService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.AUDIT_LOG_READ)
  @ApiOperation({ summary: 'Query the audit log (tenant-scoped, not itself audited)' })
  async query(@CurrentUser() user: AuthenticatedUser, @Query() dto: AuditQueryDto) {
    return this.queryService.query(user.tenantId, dto);
  }

  @Get('export')
  @RequirePermission(PERMISSIONS.AUDIT_LOG_EXPORT)
  @ApiOperation({ summary: 'Export audit log as CSV (owner/admin only; bounded; itself audited)' })
  async exportCsv(
    @CurrentUser() user: AuthenticatedUser,
    @Query() dto: AuditExportQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { csv, rowCount } = await this.queryService.exportCsv(user.tenantId, dto);

    // Audit the export itself BEFORE streaming. FAIL CLOSED
    // (#7): reading/exporting the audit log is itself an auditable event, so no
    // CSV may leave without its log row. recordOrThrow PROPAGATES a write
    // failure → the request 500s and nothing is streamed (the response has not
    // been started yet, so no partial body escapes).
    await this.audit.recordOrThrow({
      tenantId: user.tenantId,
      actorType: 'user',
      actorId: user.id,
      action: 'audit_log.exported',
      resourceType: 'audit_log',
      changes: {
        filters: {
          actorId: dto.actorId ?? null,
          resourceType: dto.resourceType ?? null,
          resourceId: dto.resourceId ?? null,
          action: dto.action ?? null,
          dateFrom: dto.dateFrom?.toISOString() ?? null,
          dateTo: dto.dateTo?.toISOString() ?? null,
        },
        rowCount,
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="audit-log-${Date.now()}.csv"`)
      .send(csv);
  }
}
