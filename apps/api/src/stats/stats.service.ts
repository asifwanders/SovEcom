/**
 * StatsService — delta math, KPI derivation, and currency resolution.
 *
 * This service contains NO DB calls directly — all data comes from StatsRepository.
 * It owns:
 *   - Default date-range (last 30 days if not provided)
 *   - Previous-window calculation: [from - (to - from), from)
 *   - Delta percent math: (value - previous) / previous * 100, rounded to 1 d.p.
 *     null when previous == 0 (frontend renders "—"/"new")
 *   - Derived KPIs: AOV = netRevenue / orderCount (guard /0 → 0)
 *   - returnRate = returnCount / orderCount (0..1 float, guard /0 → 0)
 *   - cartConversion = converted / (converted + abandoned) (0..1 float, guard /0 → 0)
 *   - Currency resolution: TenantSettingsService.defaultCurrency (falls back to most
 *     recent order currency via StatsRepository; ponytail noted in repo).
 */
import { Injectable } from '@nestjs/common';
import { StatsRepository, LOW_STOCK_THRESHOLD } from './stats.repository';
import { TenantSettingsService } from '../taxes/tenant-settings.service';
import { orderStatusEnum } from '../database/schema/_enums';

export interface MetricKpi {
  value: number;
  previous: number;
  deltaPct: number | null;
}

export interface SummaryResponse {
  range: { from: string; to: string };
  previous: { from: string; to: string };
  currency: string;
  metrics: {
    netRevenue: MetricKpi;
    orders: MetricKpi;
    averageOrderValue: MetricKpi;
    newCustomers: MetricKpi;
    returnRate: MetricKpi;
    refunds: MetricKpi;
    cartConversion: MetricKpi;
  };
}

export interface TimeseriesResponse {
  granularity: string;
  currency: string;
  points: {
    bucket: string;
    revenue: number;
    orders: number;
    newCustomers: number;
    refundAmount: number;
  }[];
}

export interface CustomerBreakdownResponse {
  range: { from: string; to: string };
  newCustomers: number;
  returningCustomers: number;
  guestOrdersExcluded: true;
}

export interface StatusBreakdownResponse {
  range: { from: string; to: string };
  statuses: { status: string; count: number }[];
}

export interface TopProductsResponse {
  by: string;
  currency: string;
  items: {
    productTitle: string;
    variantId: string | null;
    quantitySold: number;
    revenue: number;
  }[];
}

export interface AttentionResponse {
  lowStockThreshold: number;
  lowStock: {
    count: number;
    items: {
      variantId: string;
      productId: string;
      title: string;
      sku: string;
      stockQuantity: number;
    }[];
  };
  outOfStock: {
    count: number;
    items: {
      variantId: string;
      productId: string;
      title: string;
      sku: string;
      stockQuantity: number;
    }[];
  };
  pendingReturns: number;
  unfulfilledOrders: number;
  pendingPaymentOrders: number;
}

/**
 * Compute deltaPct = round((value - previous) / previous * 100, 1).
 * Returns null if previous == 0 (undefined growth base — frontend renders "—").
 */
export function computeDeltaPct(value: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((value - previous) / previous) * 100 * 10) / 10;
}

/** Guard division by zero: returns 0 if denominator is 0. */
export function safeDivide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Build a MetricKpi object from current + previous values. */
export function toKpi(value: number, previous: number): MetricKpi {
  return { value, previous, deltaPct: computeDeltaPct(value, previous) };
}

/** Round a float to 3 decimal places for rate values. */
export function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

@Injectable()
export class StatsService {
  constructor(
    private readonly repo: StatsRepository,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  /**
   * Resolve the base currency for a tenant.
   * 1. TenantSettingsService.getOnboardingProfile() → defaultCurrency (from setup wizard)
   * 2. Fallback: most recent placed order's currency
   * 3. Last resort: 'EUR'
   * // ponytail: single-currency assumption for v1; multi-currency aggregation is a Phase-4 concern.
   */
  async resolveCurrency(tenantId: string): Promise<string> {
    const profile = await this.tenantSettings.getOnboardingProfile(tenantId);
    if (profile.defaultCurrency) return profile.defaultCurrency;
    const fromOrder = await this.repo.resolveMostRecentOrderCurrency(tenantId);
    return fromOrder ?? 'EUR';
  }

  /**
   * Compute the previous window: same duration, immediately preceding `from`.
   * prevFrom = from - (to - from), prevTo = from (exclusive upper, so we use
   * 1ms before from in queries, but return the ISO strings for the response).
   */
  previousWindow(from: Date, to: Date): { prevFrom: Date; prevTo: Date } {
    const durationMs = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - durationMs);
    // Previous window ends just before the current window starts.
    // We use [prevFrom, from) exclusive on the upper bound in practice by using lt(from)
    // in the query, but the response shows the boundary as `from`.
    const prevTo = new Date(from.getTime() - 1);
    return { prevFrom, prevTo };
  }

  async getSummary(tenantId: string, from: Date, to: Date): Promise<SummaryResponse> {
    const currency = await this.resolveCurrency(tenantId);
    const { prevFrom, prevTo } = this.previousWindow(from, to);

    const [
      cur,
      prev,
      curCustomers,
      prevCustomers,
      curReturns,
      prevReturns,
      curRefunds,
      prevRefunds,
      curCart,
      prevCart,
    ] = await Promise.all([
      this.repo.getRevenueWindow(tenantId, currency, from, to),
      this.repo.getRevenueWindow(tenantId, currency, prevFrom, prevTo),
      this.repo.getNewCustomersCount(tenantId, from, to),
      this.repo.getNewCustomersCount(tenantId, prevFrom, prevTo),
      this.repo.getReturnCount(tenantId, from, to),
      this.repo.getReturnCount(tenantId, prevFrom, prevTo),
      this.repo.getRefundAmount(tenantId, currency, from, to),
      this.repo.getRefundAmount(tenantId, currency, prevFrom, prevTo),
      this.repo.getCartConversion(tenantId, from, to),
      this.repo.getCartConversion(tenantId, prevFrom, prevTo),
    ]);

    // AOV = netRevenue / orderCount (guard /0 → 0, integer minor units)
    const curAov = Math.round(safeDivide(cur.netRevenue, cur.orderCount));
    const prevAov = Math.round(safeDivide(prev.netRevenue, prev.orderCount));

    // returnRate = returnCount / orderCount (0..1 float)
    const curReturnRate = roundRate(safeDivide(curReturns, cur.orderCount));
    const prevReturnRate = roundRate(safeDivide(prevReturns, prev.orderCount));

    // cartConversion = converted / (converted + abandoned) (0..1 float)
    const curConversion = roundRate(
      safeDivide(curCart.converted, curCart.converted + curCart.abandoned),
    );
    const prevConversion = roundRate(
      safeDivide(prevCart.converted, prevCart.converted + prevCart.abandoned),
    );

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      previous: { from: prevFrom.toISOString(), to: prevTo.toISOString() },
      currency,
      metrics: {
        netRevenue: toKpi(cur.netRevenue, prev.netRevenue),
        orders: toKpi(cur.orderCount, prev.orderCount),
        averageOrderValue: toKpi(curAov, prevAov),
        newCustomers: toKpi(curCustomers, prevCustomers),
        returnRate: toKpi(curReturnRate, prevReturnRate),
        refunds: toKpi(curRefunds, prevRefunds),
        cartConversion: toKpi(curConversion, prevConversion),
      },
    };
  }

  async getTimeseries(
    tenantId: string,
    from: Date,
    to: Date,
    granularity: 'day' | 'week' | 'month',
  ): Promise<TimeseriesResponse> {
    const currency = await this.resolveCurrency(tenantId);
    const points = await this.repo.getTimeseries(tenantId, currency, from, to, granularity);
    return { granularity, currency, points };
  }

  async getTopProducts(
    tenantId: string,
    from: Date,
    to: Date,
    limit: number,
    by: 'revenue' | 'quantity',
  ): Promise<TopProductsResponse> {
    const currency = await this.resolveCurrency(tenantId);
    const items = await this.repo.getTopProducts(tenantId, currency, from, to, limit, by);
    return { by, currency, items };
  }

  async getCustomerBreakdown(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<CustomerBreakdownResponse> {
    const data = await this.repo.getCustomerBreakdown(tenantId, from, to);
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      newCustomers: data.newCustomers,
      returningCustomers: data.returningCustomers,
      guestOrdersExcluded: true,
    };
  }

  async getStatusBreakdown(
    tenantId: string,
    from: Date,
    to: Date,
  ): Promise<StatusBreakdownResponse> {
    const counts = await this.repo.getStatusBreakdown(tenantId, from, to);
    const byStatus = new Map(counts.map((c) => [c.status, c.count]));
    // Zero-fill: emit ALL 9 statuses in the canonical enum order so the donut is stable.
    const statuses = orderStatusEnum.enumValues.map((status) => ({
      status,
      count: byStatus.get(status) ?? 0,
    }));
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      statuses,
    };
  }

  async getAttention(tenantId: string): Promise<AttentionResponse> {
    const data = await this.repo.getAttention(tenantId);
    return {
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      lowStock: { count: data.lowStockCount, items: data.lowStockItems },
      outOfStock: { count: data.outOfStockCount, items: data.outOfStockItems },
      pendingReturns: data.pendingReturns,
      unfulfilledOrders: data.unfulfilledOrders,
      pendingPaymentOrders: data.pendingPaymentOrders,
    };
  }
}
