/**
 * AuthorizationModule (SECURITY-CRITICAL).
 *
 * Registers {@link PermissionsGuard} GLOBALLY via `APP_GUARD`. MUST be imported
 * AFTER `AuthModule` in `AppModule` so the JWT guard (which populates `req.user`)
 * runs first; the guard is fail-closed regardless, but ordering keeps valid
 * requests working. `AuditService` is global (AuditModule is `@Global`).
 */
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PermissionsService } from './services/permissions.service';
import { PermissionsGuard } from './guards/permissions.guard';

@Module({
  providers: [PermissionsService, { provide: APP_GUARD, useClass: PermissionsGuard }],
  exports: [PermissionsService],
})
export class AuthorizationModule {}
