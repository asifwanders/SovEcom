/**
 * AuditModule.
 *
 * Global audit-write seam. Additions:
 *   - AuditInterceptor   registered as a global APP_INTERCEPTOR — fires after
 *                        successful (2xx) responses on @Audit-decorated routes.
 *   - AuditRepository    data-access layer for the read API.
 *   - AuditQueryService  read-only service (query + CSV export).
 *   - AuditAdminController  /admin/v1/audit-log + /export.
 *
 * `DatabaseService` is @Global, so it injects without an explicit import.
 * `AuditService` is kept exported for all other modules that call record().
 */
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './audit.service';
import { AuditInterceptor } from './audit.interceptor';
import { AuditRepository } from './audit.repository';
import { AuditQueryService } from './audit-query.service';
import { AuditAdminController } from './controllers/audit.controller.admin';

@Global()
@Module({
  controllers: [AuditAdminController],
  providers: [
    AuditService,
    AuditRepository,
    AuditQueryService,
    // Global interceptor — fires after successful responses on @Audit routes.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
