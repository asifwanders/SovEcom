/**
 * Admin Stats Controller. Routes: /admin/v1/stats.
 *
 * Behind the global admin JwtAuthGuard + PermissionsGuard.
 * All 6 endpoints require `dashboard:read` (PERMISSIONS.DASHBOARD_READ).
 * Tenant-scoped via `user.tenantId` from the DB-sourced principal.
 *
 *   GET  /admin/v1/stats/summary?from&to                 → summary KPIs + delta
 *   GET  /admin/v1/stats/timeseries?from&to&granularity  → zero-filled revenue/orders/newCustomers/refunds series
 *   GET  /admin/v1/stats/top-products?from&to&limit&by   → top products by revenue or quantity
 *   GET  /admin/v1/stats/attention                       → current-state stock/operations alerts
 *   GET  /admin/v1/stats/customer-breakdown?from&to      → new-vs-returning customer counts
 *   GET  /admin/v1/stats/status-breakdown?from&to        → order counts per status (all 9, zero-filled)
 */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../authorization/decorators/require-permission.decorator';
import { PERMISSIONS } from '../authorization/permissions.constants';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { StatsService } from './stats.service';
import { SummaryQueryDto, TimeseriesQueryDto, TopProductsQueryDto } from './dto/stats-query.dto';
// customer-breakdown + status-breakdown reuse SummaryQueryDto (same from/to window contract).

@ApiTags('Admin / Stats')
@Controller('admin/v1/stats')
export class StatsAdminController {
  constructor(private readonly stats: StatsService) {}

  @Get('summary')
  @RequirePermission(PERMISSIONS.DASHBOARD_READ)
  @ApiOperation({ summary: 'Dashboard summary KPIs with delta vs previous equal-length window' })
  summary(@CurrentUser() user: AuthenticatedUser, @Query() query: SummaryQueryDto) {
    return this.stats.getSummary(user.tenantId, query.from, query.to);
  }

  @Get('timeseries')
  @RequirePermission(PERMISSIONS.DASHBOARD_READ)
  @ApiOperation({ summary: 'Zero-filled revenue+order-count timeseries for a date range' })
  timeseries(@CurrentUser() user: AuthenticatedUser, @Query() query: TimeseriesQueryDto) {
    return this.stats.getTimeseries(
      user.tenantId,
      query.from,
      query.to,
      query.granularity as 'day' | 'week' | 'month',
    );
  }

  @Get('top-products')
  @RequirePermission(PERMISSIONS.DASHBOARD_READ)
  @ApiOperation({ summary: 'Top products by revenue or quantity for a date range' })
  topProducts(@CurrentUser() user: AuthenticatedUser, @Query() query: TopProductsQueryDto) {
    return this.stats.getTopProducts(
      user.tenantId,
      query.from,
      query.to,
      query.limit,
      query.by as 'revenue' | 'quantity',
    );
  }

  @Get('attention')
  @RequirePermission(PERMISSIONS.DASHBOARD_READ)
  @ApiOperation({ summary: 'Current-state stock alerts, pending returns, unfulfilled orders' })
  attention(@CurrentUser() user: AuthenticatedUser) {
    return this.stats.getAttention(user.tenantId);
  }

  @Get('customer-breakdown')
  @RequirePermission(PERMISSIONS.DASHBOARD_READ)
  @ApiOperation({ summary: 'New-vs-returning customer split for a date range (guests excluded)' })
  customerBreakdown(@CurrentUser() user: AuthenticatedUser, @Query() query: SummaryQueryDto) {
    return this.stats.getCustomerBreakdown(user.tenantId, query.from, query.to);
  }

  @Get('status-breakdown')
  @RequirePermission(PERMISSIONS.DASHBOARD_READ)
  @ApiOperation({ summary: 'Order counts grouped by status (all 9 statuses) for a date range' })
  statusBreakdown(@CurrentUser() user: AuthenticatedUser, @Query() query: SummaryQueryDto) {
    return this.stats.getStatusBreakdown(user.tenantId, query.from, query.to);
  }
}
