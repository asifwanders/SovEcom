/**
 * Admin Users Controller (SECURITY-CRITICAL: auth principal + privilege-escalation path).
 *
 * Routes: /admin/v1/users. Behind the GLOBAL admin JwtAuthGuard + PermissionsGuard.
 *   USERS_READ  — list
 *   USERS_WRITE — create, role-change, deactivate, reactivate
 *
 * Tenant-scoped via `user.tenantId` from the DB-sourced principal (never from
 * the request body or params). Every mutating route is @Audit-tagged.
 *
 * Security guards enforced in UsersService:
 *   - role ∈ {admin, staff} only (never owner)
 *   - no self role-change / self-deactivate (403)
 *   - cross-tenant targets → 404
 *   - password breach-check + argon2id hash
 *   - token_version bump on role-change / deactivate
 *
 * Response shape NEVER includes password_hash or totp_secret.
 */
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { UsersService } from './users.service';
import { CreateUserDto, ChangeRoleDto, UsersQueryDto } from './dto/users-admin.dto';

@ApiTags('Admin / Users')
@Controller('admin/v1/users')
export class UsersAdminController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission(PERMISSIONS.USERS_READ)
  @ApiOperation({ summary: 'List staff accounts for this tenant (paginated)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: UsersQueryDto) {
    return this.users.list(user.tenantId, query.page, query.pageSize);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission(PERMISSIONS.USERS_WRITE)
  @Audit('user.created')
  @ApiOperation({ summary: 'Create a new admin or staff account' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUserDto) {
    return this.users.create(user.tenantId, dto);
  }

  @Patch(':id/role')
  @RequirePermission(PERMISSIONS.USERS_WRITE)
  @Audit('user.role_changed')
  @ApiOperation({
    summary: 'Change the role of a staff account (admin/staff only; not owner; not self)',
  })
  changeRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ChangeRoleDto,
  ) {
    return this.users.changeRole(user.tenantId, user.id, id, dto.role);
  }

  @Patch(':id/deactivate')
  @RequirePermission(PERMISSIONS.USERS_WRITE)
  @Audit('user.deactivated')
  @ApiOperation({ summary: 'Deactivate a staff account (sets disabled_at; invalidates sessions)' })
  deactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.users.deactivate(user.tenantId, user.id, id);
  }

  @Patch(':id/reactivate')
  @RequirePermission(PERMISSIONS.USERS_WRITE)
  @Audit('user.reactivated')
  @ApiOperation({ summary: 'Reactivate a disabled staff account (clears disabled_at)' })
  reactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.users.reactivate(user.tenantId, id);
  }
}
