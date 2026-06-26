/**
 * Admin Slots controller. Routes:
 * /admin/v1/slots.
 *
 * RBAC-gated with `themes:read` / `themes:write` (the slot registry is part of the theme/
 * rendering surface; owner+admin only, staff fail-closed). The resolution PUT is
 * `@Audit`-tagged (an admin choosing a slot winner is a recorded admin action). Tenant-scoped
 * via `@CurrentUser().tenantId`. The service's NotFound (404) / Unprocessable (422) for an
 * invalid resolution propagate unchanged.
 */
import { Body, Controller, Get, HttpCode, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { SlotRegistryService, type ResolvedSlot, type SlotConflict } from './slot-registry.service';
import { parseSlotName, parseSlotResolution } from './dto/slot-resolution.dto';

/** The admin view of the slot registry: cleanly-resolved slots + the conflicts to resolve. */
interface SlotRegistryView {
  readonly resolved: ResolvedSlot[];
  readonly conflicts: SlotConflict[];
}

@ApiTags('Admin / Slots')
@Controller('admin/v1/slots')
export class SlotsAdminController {
  constructor(private readonly registry: SlotRegistryService) {}

  @Get()
  @RequirePermission(PERMISSIONS.THEMES_READ)
  @ApiOperation({ summary: 'List resolved slots + conflicts the admin must resolve' })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<SlotRegistryView> {
    // ONE computeState run (via state()) so resolved + conflicts are a single consistent snapshot —
    // separate resolved()/conflicts() calls would run computeState twice over two reads.
    return this.registry.state(user.tenantId);
  }

  @Put(':slot/resolution')
  @HttpCode(204)
  @RequirePermission(PERMISSIONS.THEMES_WRITE)
  @Audit('slot.resolved')
  @ApiOperation({ summary: 'Pick the winning module for a contested slot (admin choice)' })
  async setResolution(
    @CurrentUser() user: AuthenticatedUser,
    @Param('slot') slot: string,
    @Body() body: { module?: unknown } = {},
  ): Promise<void> {
    const slotName = parseSlotName(slot);
    const moduleName = parseSlotResolution(body?.module);
    await this.registry.setResolution(user.tenantId, slotName, moduleName);
  }
}
