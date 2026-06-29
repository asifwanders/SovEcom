/**
 * StatsService unit tests.
 *
 * All collaborators are mocked (no DB, no network).
 * Critical invariants under test:
 *   - computeDeltaPct: previous==0 → null; positive/negative deltas; rounding.
 *   - safeDivide: /0 guard always returns 0.
 *   - AOV is integer rounded (netRevenue / orderCount, /0 → 0).
 *   - returnRate = returnCount / orderCount (0..1 float, /0 → 0).
 *   - cartConversion = converted / (converted + abandoned) (0..1 float, /0 → 0).
 *   - currency resolution: uses TenantSettingsService defaultCurrency first, fallback to repo.
 *   - previousWindow: correct duration subtraction.
 */
import { computeDeltaPct, safeDivide, roundRate, toKpi, StatsService } from './stats.service';
import type { StatsRepository } from './stats.repository';
import type { TenantSettingsService } from '../taxes/tenant-settings.service';

// ── Pure function unit tests ──────────────────────────────────────────────────

describe('computeDeltaPct', () => {
  it('returns null when previous == 0', () => {
    expect(computeDeltaPct(100, 0)).toBeNull();
    expect(computeDeltaPct(0, 0)).toBeNull();
  });

  it('returns 0.0 when value == previous', () => {
    expect(computeDeltaPct(100, 100)).toBe(0);
  });

  it('computes positive delta correctly (2 decimal example)', () => {
    // (822064 - 800000) / 800000 * 100 = 2.758 → 2.8 (rounded to 1 dp)
    expect(computeDeltaPct(822064, 800000)).toBe(2.8);
  });

  it('computes spec example: orders (2500, 2345) → 6.6', () => {
    // (2500 - 2345) / 2345 * 100 = 6.611... → 6.6
    expect(computeDeltaPct(2500, 2345)).toBe(6.6);
  });

  it('computes negative delta', () => {
    // (80 - 100) / 100 * 100 = -20.0
    expect(computeDeltaPct(80, 100)).toBe(-20);
  });

  it('rounds to 1 decimal place', () => {
    // (15 - 13) / 13 * 100 = 15.384... → 15.4
    expect(computeDeltaPct(15, 13)).toBe(15.4);
  });
});

describe('safeDivide', () => {
  it('returns 0 when denominator is 0', () => {
    expect(safeDivide(100, 0)).toBe(0);
    expect(safeDivide(0, 0)).toBe(0);
  });

  it('returns numerator/denominator when denominator != 0', () => {
    expect(safeDivide(100, 4)).toBe(25);
    expect(safeDivide(1, 3)).toBeCloseTo(0.333, 3);
  });
});

describe('toKpi', () => {
  it('builds a MetricKpi with correct deltaPct', () => {
    const kpi = toKpi(110, 89);
    expect(kpi.value).toBe(110);
    expect(kpi.previous).toBe(89);
    // (110 - 89) / 89 * 100 = 23.595... → 23.6
    expect(kpi.deltaPct).toBe(23.6);
  });

  it('deltaPct is null when previous == 0', () => {
    expect(toKpi(5, 0).deltaPct).toBeNull();
  });
});

describe('roundRate', () => {
  it('rounds to 3 decimal places', () => {
    expect(roundRate(0.7083)).toBe(0.708);
    expect(roundRate(1 / 3)).toBe(0.333);
  });
});

// ── StatsService integration (mocked deps) ───────────────────────────────────

function makeRepo(): jest.Mocked<StatsRepository> {
  return {
    resolveMostRecentOrderCurrency: jest.fn().mockResolvedValue('EUR'),
    getRevenueWindow: jest
      .fn()
      .mockResolvedValue({ netRevenue: 0, orderCount: 0, currency: 'EUR' }),
    getNewCustomersCount: jest.fn().mockResolvedValue(0),
    getReturnCount: jest.fn().mockResolvedValue(0),
    getRefundAmount: jest.fn().mockResolvedValue(0),
    getCartConversion: jest.fn().mockResolvedValue({ converted: 0, abandoned: 0 }),
    getTimeseries: jest.fn().mockResolvedValue([]),
    getTopProducts: jest.fn().mockResolvedValue([]),
    getAttention: jest.fn().mockResolvedValue({
      lowStockItems: [],
      lowStockCount: 0,
      outOfStockItems: [],
      outOfStockCount: 0,
      pendingReturns: 0,
      unfulfilledOrders: 0,
      pendingPaymentOrders: 0,
    }),
    getCustomerBreakdown: jest.fn().mockResolvedValue({ newCustomers: 0, returningCustomers: 0 }),
    getStatusBreakdown: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<StatsRepository>;
}

function makeSettings(defaultCurrency: string | null): jest.Mocked<TenantSettingsService> {
  return {
    getOnboardingProfile: jest.fn().mockResolvedValue({ defaultCurrency, businessCountry: null }),
  } as unknown as jest.Mocked<TenantSettingsService>;
}

describe('StatsService.resolveCurrency', () => {
  it('uses TenantSettingsService.defaultCurrency when set', async () => {
    const service = new StatsService(makeRepo(), makeSettings('USD'));
    expect(await service.resolveCurrency('t1')).toBe('USD');
  });

  it('falls back to most recent order currency when defaultCurrency is null', async () => {
    const repo = makeRepo();
    repo.resolveMostRecentOrderCurrency.mockResolvedValue('GBP');
    const service = new StatsService(repo, makeSettings(null));
    expect(await service.resolveCurrency('t1')).toBe('GBP');
  });

  it('falls back to EUR when no currency configured and no orders exist', async () => {
    const repo = makeRepo();
    repo.resolveMostRecentOrderCurrency.mockResolvedValue(null);
    const service = new StatsService(repo, makeSettings(null));
    expect(await service.resolveCurrency('t1')).toBe('EUR');
  });
});

describe('StatsService.previousWindow', () => {
  it('returns a previous window of the same duration immediately before from', () => {
    const service = new StatsService(makeRepo(), makeSettings('EUR'));
    const from = new Date('2026-06-01T00:00:00Z');
    const to = new Date('2026-06-30T23:59:59Z');
    const { prevFrom, prevTo } = service.previousWindow(from, to);

    const durationMs = to.getTime() - from.getTime();
    expect(prevFrom.getTime()).toBe(from.getTime() - durationMs);
    // prevTo is 1ms before from
    expect(prevTo.getTime()).toBe(from.getTime() - 1);
  });
});

describe('StatsService.getSummary', () => {
  const from = new Date('2026-06-01T00:00:00Z');
  const to = new Date('2026-06-30T23:59:59Z');

  it('returns zero-state summary when no data', async () => {
    const service = new StatsService(makeRepo(), makeSettings('EUR'));
    const result = await service.getSummary('t1', from, to);

    expect(result.currency).toBe('EUR');
    expect(result.metrics.netRevenue.value).toBe(0);
    expect(result.metrics.orders.value).toBe(0);
    // AOV: 0 / 0 = 0 (guard /0)
    expect(result.metrics.averageOrderValue.value).toBe(0);
    expect(result.metrics.newCustomers.value).toBe(0);
    // returnRate: 0 / 0 = 0 (guard /0)
    expect(result.metrics.returnRate.value).toBe(0);
    // All deltas null (previous == 0)
    expect(result.metrics.netRevenue.deltaPct).toBeNull();
    expect(result.metrics.orders.deltaPct).toBeNull();
  });

  it('computes AOV = netRevenue / orderCount (integer minor units)', async () => {
    const repo = makeRepo();
    // current window: 822064 cents revenue, 25 orders → AOV = 32882
    repo.getRevenueWindow
      .mockResolvedValueOnce({ netRevenue: 822064, orderCount: 25, currency: 'EUR' })
      .mockResolvedValueOnce({ netRevenue: 800000, orderCount: 20, currency: 'EUR' });
    const service = new StatsService(repo, makeSettings('EUR'));
    const result = await service.getSummary('t1', from, to);
    expect(result.metrics.averageOrderValue.value).toBe(Math.round(822064 / 25)); // 32882
    expect(result.metrics.averageOrderValue.previous).toBe(Math.round(800000 / 20)); // 40000
  });

  it('AOV is 0 when order count is 0 (no /0 crash)', async () => {
    const repo = makeRepo();
    repo.getRevenueWindow
      .mockResolvedValueOnce({ netRevenue: 0, orderCount: 0, currency: 'EUR' })
      .mockResolvedValueOnce({ netRevenue: 0, orderCount: 0, currency: 'EUR' });
    const service = new StatsService(repo, makeSettings('EUR'));
    const result = await service.getSummary('t1', from, to);
    expect(result.metrics.averageOrderValue.value).toBe(0);
    expect(result.metrics.averageOrderValue.deltaPct).toBeNull();
  });

  it('returnRate = returnCount / orderCount (0..1 float)', async () => {
    const repo = makeRepo();
    repo.getRevenueWindow
      .mockResolvedValueOnce({ netRevenue: 100000, orderCount: 100, currency: 'EUR' })
      .mockResolvedValueOnce({ netRevenue: 100000, orderCount: 100, currency: 'EUR' });
    repo.getReturnCount.mockResolvedValueOnce(6).mockResolvedValueOnce(5);
    const service = new StatsService(repo, makeSettings('EUR'));
    const result = await service.getSummary('t1', from, to);
    // 6/100 = 0.06
    expect(result.metrics.returnRate.value).toBe(0.06);
    // 5/100 = 0.05
    expect(result.metrics.returnRate.previous).toBe(0.05);
  });

  it('returnRate is 0 when orderCount is 0 (no /0 crash)', async () => {
    const repo = makeRepo();
    repo.getRevenueWindow.mockResolvedValue({ netRevenue: 0, orderCount: 0, currency: 'EUR' });
    repo.getReturnCount.mockResolvedValue(3);
    const service = new StatsService(repo, makeSettings('EUR'));
    const result = await service.getSummary('t1', from, to);
    expect(result.metrics.returnRate.value).toBe(0);
    expect(result.metrics.returnRate.previous).toBe(0);
  });

  it('cartConversion = converted / (converted + abandoned) (0..1 float)', async () => {
    const repo = makeRepo();
    repo.getCartConversion
      .mockResolvedValueOnce({ converted: 708, abandoned: 292 })
      .mockResolvedValueOnce({ converted: 66, abandoned: 34 });
    const service = new StatsService(repo, makeSettings('EUR'));
    const result = await service.getSummary('t1', from, to);
    // 708/(708+292) = 0.708
    expect(result.metrics.cartConversion.value).toBe(0.708);
    // 66/(66+34) = 0.66
    expect(result.metrics.cartConversion.previous).toBe(0.66);
  });

  it('cartConversion is 0 when no carts (no /0 crash)', async () => {
    const service = new StatsService(makeRepo(), makeSettings('EUR'));
    const result = await service.getSummary('t1', from, to);
    expect(result.metrics.cartConversion.value).toBe(0);
    expect(result.metrics.cartConversion.deltaPct).toBeNull();
  });

  it('range and previous ISO strings are correct in response shape', async () => {
    const service = new StatsService(makeRepo(), makeSettings('EUR'));
    const result = await service.getSummary('t1', from, to);
    expect(result.range.from).toBe(from.toISOString());
    expect(result.range.to).toBe(to.toISOString());
    // previous from should be 30 days earlier
    const durationMs = to.getTime() - from.getTime();
    expect(new Date(result.previous.from).getTime()).toBe(from.getTime() - durationMs);
  });
});

describe('StatsService.getAttention', () => {
  it('maps repo data to the correct response shape', async () => {
    const repo = makeRepo();
    repo.getAttention.mockResolvedValue({
      lowStockItems: [
        { variantId: 'v1', productId: 'p1', title: 'Jacket S', sku: 'JAC-S', stockQuantity: 2 },
      ],
      lowStockCount: 20,
      outOfStockItems: [],
      outOfStockCount: 3,
      pendingReturns: 5,
      unfulfilledOrders: 12,
      pendingPaymentOrders: 4,
    });
    const service = new StatsService(repo, makeSettings('EUR'));
    const result = await service.getAttention('t1');
    expect(result.lowStockThreshold).toBe(5);
    expect(result.lowStock.count).toBe(20);
    expect(result.lowStock.items).toHaveLength(1);
    expect(result.lowStock.items[0]?.variantId).toBe('v1');
    expect(result.outOfStock.count).toBe(3);
    expect(result.pendingReturns).toBe(5);
    expect(result.unfulfilledOrders).toBe(12);
    expect(result.pendingPaymentOrders).toBe(4);
  });
});

// ── 3.22b extensions ─────────────────────────────────────────────────────────

describe('StatsService.getTimeseries (extended fields)', () => {
  const from = new Date('2026-06-01T00:00:00Z');
  const to = new Date('2026-06-03T23:59:59Z');

  it('passes through newCustomers + refundAmount from the repo per point', async () => {
    const repo = makeRepo();
    repo.getTimeseries.mockResolvedValue([
      { bucket: '2026-06-01', revenue: 1000, orders: 2, newCustomers: 3, refundAmount: 500 },
      { bucket: '2026-06-02', revenue: 0, orders: 0, newCustomers: 0, refundAmount: 0 },
    ]);
    const service = new StatsService(repo, makeSettings('EUR'));
    const result = await service.getTimeseries('t1', from, to, 'day');
    expect(result.points).toHaveLength(2);
    expect(result.points[0]).toEqual({
      bucket: '2026-06-01',
      revenue: 1000,
      orders: 2,
      newCustomers: 3,
      refundAmount: 500,
    });
    // Zero-filled bucket keeps the new fields at 0.
    expect(result.points[1]?.newCustomers).toBe(0);
    expect(result.points[1]?.refundAmount).toBe(0);
  });

  it('resolves the currency and threads it to the repo (for currency-filtered refunds)', async () => {
    const repo = makeRepo();
    const service = new StatsService(repo, makeSettings('USD'));
    await service.getTimeseries('t1', from, to, 'week');
    expect(repo.getTimeseries).toHaveBeenCalledWith('t1', 'USD', from, to, 'week');
  });
});

describe('StatsService.getCustomerBreakdown', () => {
  const from = new Date('2026-06-01T00:00:00Z');
  const to = new Date('2026-06-30T23:59:59Z');

  it('maps repo split to the response shape with guestOrdersExcluded:true', async () => {
    const repo = makeRepo();
    repo.getCustomerBreakdown.mockResolvedValue({ newCustomers: 7, returningCustomers: 3 });
    const service = new StatsService(repo, makeSettings('EUR'));
    const result = await service.getCustomerBreakdown('t1', from, to);
    expect(result.newCustomers).toBe(7);
    expect(result.returningCustomers).toBe(3);
    expect(result.guestOrdersExcluded).toBe(true);
    expect(result.range.from).toBe(from.toISOString());
    expect(result.range.to).toBe(to.toISOString());
  });

  it('zero-state maps to 0/0', async () => {
    const service = new StatsService(makeRepo(), makeSettings('EUR'));
    const result = await service.getCustomerBreakdown('t1', from, to);
    expect(result.newCustomers).toBe(0);
    expect(result.returningCustomers).toBe(0);
  });
});

describe('StatsService.getStatusBreakdown', () => {
  const from = new Date('2026-06-01T00:00:00Z');
  const to = new Date('2026-06-30T23:59:59Z');

  it('zero-fills ALL 9 statuses in canonical enum order', async () => {
    const repo = makeRepo();
    repo.getStatusBreakdown.mockResolvedValue([
      { status: 'paid', count: 5 },
      { status: 'cancelled', count: 2 },
    ]);
    const service = new StatsService(repo, makeSettings('EUR'));
    const result = await service.getStatusBreakdown('t1', from, to);
    expect(result.statuses).toHaveLength(9);
    const map = new Map(result.statuses.map((s) => [s.status, s.count]));
    expect(map.get('paid')).toBe(5);
    expect(map.get('cancelled')).toBe(2);
    // Absent statuses zero-filled.
    expect(map.get('pending_payment')).toBe(0);
    expect(map.get('refunded')).toBe(0);
    expect(map.get('partially_refunded')).toBe(0);
    // Canonical order: first must be pending_payment, last partially_refunded.
    expect(result.statuses[0]?.status).toBe('pending_payment');
    expect(result.statuses[8]?.status).toBe('partially_refunded');
  });

  it('emits all 9 statuses at 0 when there are no orders', async () => {
    const service = new StatsService(makeRepo(), makeSettings('EUR'));
    const result = await service.getStatusBreakdown('t1', from, to);
    expect(result.statuses).toHaveLength(9);
    expect(result.statuses.every((s) => s.count === 0)).toBe(true);
  });
});
