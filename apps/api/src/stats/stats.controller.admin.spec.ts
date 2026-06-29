/**
 * StatsAdminController unit tests.
 *
 * The controller is thin (delegates entirely to StatsService). Tests verify:
 *   - Each endpoint calls the correct service method with the correct args.
 *   - `user.tenantId` is correctly threaded from the CurrentUser principal.
 *   - The response is the service return value (no transformation at the controller level).
 *
 * Auth/permission gate (guard-level: requires dashboard:read) is verified in the
 * integration test (stats.int-spec.ts), not here.
 */
import { StatsAdminController } from './stats.controller.admin';
import type { StatsService } from './stats.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';

const TENANT_ID = 'tenant-test-001';
const user: AuthenticatedUser = {
  tenantId: TENANT_ID,
  id: 'user-1',
  role: 'admin',
} as AuthenticatedUser;

function makeService(): jest.Mocked<StatsService> {
  return {
    getSummary: jest.fn().mockResolvedValue({ currency: 'EUR', metrics: {} }),
    getTimeseries: jest.fn().mockResolvedValue({ granularity: 'day', currency: 'EUR', points: [] }),
    getTopProducts: jest.fn().mockResolvedValue({ by: 'revenue', currency: 'EUR', items: [] }),
    getAttention: jest
      .fn()
      .mockResolvedValue({
        lowStockThreshold: 5,
        lowStock: { count: 0, items: [] },
        outOfStock: { count: 0, items: [] },
        pendingReturns: 0,
        unfulfilledOrders: 0,
        pendingPaymentOrders: 0,
      }),
    getCustomerBreakdown: jest
      .fn()
      .mockResolvedValue({
        range: { from: '', to: '' },
        newCustomers: 0,
        returningCustomers: 0,
        guestOrdersExcluded: true,
      }),
    getStatusBreakdown: jest.fn().mockResolvedValue({ range: { from: '', to: '' }, statuses: [] }),
    resolveCurrency: jest.fn().mockResolvedValue('EUR'),
    previousWindow: jest.fn(),
  } as unknown as jest.Mocked<StatsService>;
}

describe('StatsAdminController', () => {
  describe('summary()', () => {
    it('calls stats.getSummary with tenantId and parsed dates', async () => {
      const service = makeService();
      const controller = new StatsAdminController(service);
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-30T23:59:59.000Z');
      const result = await controller.summary(user, { from, to } as any);
      expect(service.getSummary).toHaveBeenCalledWith(TENANT_ID, from, to);
      expect(result).toEqual({ currency: 'EUR', metrics: {} });
    });
  });

  describe('timeseries()', () => {
    it('calls stats.getTimeseries with tenantId, dates, and granularity', async () => {
      const service = makeService();
      const controller = new StatsAdminController(service);
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-30T23:59:59.000Z');
      await controller.timeseries(user, { from, to, granularity: 'week' } as any);
      expect(service.getTimeseries).toHaveBeenCalledWith(TENANT_ID, from, to, 'week');
    });

    it('defaults granularity to "day" when not provided (DTO default)', async () => {
      const service = makeService();
      const controller = new StatsAdminController(service);
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-30T23:59:59.000Z');
      // The DTO layer applies the default; here we simulate the already-defaulted value.
      await controller.timeseries(user, { from, to, granularity: 'day' } as any);
      expect(service.getTimeseries).toHaveBeenCalledWith(TENANT_ID, from, to, 'day');
    });
  });

  describe('topProducts()', () => {
    it('calls stats.getTopProducts with tenantId, dates, limit, and sort key', async () => {
      const service = makeService();
      const controller = new StatsAdminController(service);
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-30T23:59:59.000Z');
      await controller.topProducts(user, { from, to, limit: 10, by: 'quantity' } as any);
      expect(service.getTopProducts).toHaveBeenCalledWith(TENANT_ID, from, to, 10, 'quantity');
    });
  });

  describe('attention()', () => {
    it('calls stats.getAttention with tenantId and returns the result', async () => {
      const service = makeService();
      const controller = new StatsAdminController(service);
      const result = await controller.attention(user);
      expect(service.getAttention).toHaveBeenCalledWith(TENANT_ID);
      expect(result.lowStockThreshold).toBe(5);
    });
  });

  describe('customerBreakdown()', () => {
    it('calls stats.getCustomerBreakdown with tenantId and parsed dates', async () => {
      const service = makeService();
      const controller = new StatsAdminController(service);
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-30T23:59:59.000Z');
      await controller.customerBreakdown(user, { from, to } as any);
      expect(service.getCustomerBreakdown).toHaveBeenCalledWith(TENANT_ID, from, to);
    });
  });

  describe('statusBreakdown()', () => {
    it('calls stats.getStatusBreakdown with tenantId and parsed dates', async () => {
      const service = makeService();
      const controller = new StatsAdminController(service);
      const from = new Date('2026-06-01T00:00:00.000Z');
      const to = new Date('2026-06-30T23:59:59.000Z');
      await controller.statusBreakdown(user, { from, to } as any);
      expect(service.getStatusBreakdown).toHaveBeenCalledWith(TENANT_ID, from, to);
    });
  });
});
