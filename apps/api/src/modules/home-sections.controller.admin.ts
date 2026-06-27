/**
 * Admin Home Sections controller. Routes: /admin/v1/storefront/home-sections.
 *
 * RBAC-gated with `themes:read` / `themes:write` permissions (owner+admin only;
 * staff is fail-closed). The PUT is `@Audit`-tagged. Validation is delegated entirely to the
 * service (which calls `parseMarketingSection` per entry and rejects the whole request on any
 * invalid entry). The controller owns only request/response shape and permission enforcement.
 */
import { BadRequestException, Body, Controller, Get, HttpCode, Put } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { Audit } from '../audit/decorators/audit.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { HomeSectionsService, type HomeSectionsView } from './home-sections.service';

/** Request body for PUT /admin/v1/storefront/home-sections. */
class PutHomeSectionsBody {
  @ApiProperty({
    description:
      'The ordered list of marketing section descriptors for the home page. ' +
      'Each entry must be a `{ type, settings }` object. ' +
      'Every entry is validated by the SDK schema — a single invalid entry rejects the whole request. ' +
      'Capped at 50 entries.',
    type: 'array',
    items: { type: 'object' },
  })
  sections!: unknown[];
}

@ApiTags('Admin / Storefront')
@Controller('admin/v1/storefront/home-sections')
export class HomeSectionsAdminController {
  constructor(private readonly homeSections: HomeSectionsService) {}

  @Get()
  @RequirePermission(PERMISSIONS.THEMES_READ)
  @ApiOperation({ summary: 'Get the tenant home-page marketing sections (admin)' })
  get(@CurrentUser() user: AuthenticatedUser): Promise<HomeSectionsView> {
    return this.homeSections.getForAdmin(user.tenantId);
  }

  @Put()
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.THEMES_WRITE)
  @Audit('storefront.home_sections_updated')
  @ApiOperation({
    summary:
      'Replace the tenant home-page marketing sections (fail-closed: all entries validated or request rejected)',
  })
  replace(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PutHomeSectionsBody,
  ): Promise<HomeSectionsView> {
    const sections = body?.sections;
    if (!Array.isArray(sections)) {
      throw new BadRequestException('body.sections must be an array');
    }
    return this.homeSections.replace(user.tenantId, sections);
  }
}
