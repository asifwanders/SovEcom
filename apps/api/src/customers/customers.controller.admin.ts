/**
 * Admin Customers Controller (SECURITY-CRITICAL).
 *
 * Routes: /admin/v1/customers. Behind the GLOBAL admin JwtAuthGuard + the global
 * PermissionsGuard — each handler declares the exact permission it needs:
 *   read  (list/get/addresses) — staff + admin + owner
 *   write (create/update)      — admin + owner
 *   delete (RGPD erase)        — admin + owner
 * Every query is tenant-scoped via `user.tenantId` (the DB-sourced principal).
 * Erase is audited inside RgpdService (actor = admin, who erased whom).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CustomersService } from './customers.service';
import { AddressesService } from './addresses/addresses.service';
import { RgpdService } from './rgpd/rgpd.service';
import { CustomerQueryDto } from './dto/customer-query.dto';
import { AdminCreateCustomerDto } from './dto/admin-create-customer.dto';
import { AdminUpdateCustomerDto } from './dto/admin-update-customer.dto';
import { AdminEraseDto } from './dto/rgpd.dto';

@ApiTags('Admin / Customers')
@Controller('admin/v1/customers')
export class CustomersAdminController {
  constructor(
    private readonly customers: CustomersService,
    private readonly addresses: AddressesService,
    private readonly rgpd: RgpdService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.CUSTOMERS_READ)
  @ApiOperation({ summary: 'List customers (offset pagination, filters)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: CustomerQueryDto) {
    return this.customers.adminList(user.tenantId, query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.CUSTOMERS_WRITE)
  @ApiOperation({ summary: 'Create a customer (VIES check if VAT supplied)' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AdminCreateCustomerDto,
    @Req() req: Request,
  ) {
    return this.customers.adminCreate(user.tenantId, user.id, dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.CUSTOMERS_READ)
  @ApiOperation({ summary: 'Get a customer by id' })
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.customers.adminGet(user.tenantId, id);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.CUSTOMERS_WRITE)
  @ApiOperation({ summary: 'Update a customer (VIES re-check if VAT changes)' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminUpdateCustomerDto,
    @Req() req: Request,
  ) {
    return this.customers.adminUpdate(user.tenantId, user.id, id, dto, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.CUSTOMERS_DELETE)
  @ApiOperation({ summary: 'RGPD erase a customer (confirmEmail echo; irreversible; audited)' })
  erase(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminEraseDto,
    @Req() req: Request,
  ): Promise<void> {
    // `confirmEmail` must match the target's current email (enforced in the service
    // against the loaded row); a mismatch/missing value → 400, no-op.
    return this.rgpd.eraseAsAdmin(user.tenantId, user.id, id, dto.confirmEmail, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Get(':id/addresses')
  @RequirePermission(PERMISSIONS.CUSTOMERS_READ)
  @ApiOperation({ summary: "List a customer's addresses" })
  async addressesFor(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    // 404 the addresses endpoint when the customer is not in this tenant.
    await this.customers.adminGet(user.tenantId, id);
    return this.addresses.list(user.tenantId, id);
  }
}
