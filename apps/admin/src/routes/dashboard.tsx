import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n-context';
import { PeriodSelector } from '@/components/dashboard/PeriodSelector';
import { KpiTiles } from '@/components/dashboard/KpiTiles';
import { RevenueChart } from '@/components/dashboard/RevenueChart';
import { AttentionRow } from '@/components/dashboard/AttentionRow';
import { TopProducts } from '@/components/dashboard/TopProducts';
import { RecentOrders } from '@/components/dashboard/RecentOrders';
import { CustomerBreakdown } from '@/components/dashboard/CustomerBreakdown';
import { StatusDonut } from '@/components/dashboard/StatusDonut';
import type {
  PeriodState,
  Granularity,
  TopBy,
  SummaryResponse,
  TimeseriesResponse,
  TopProductsResponse,
  AttentionResponse,
  CustomerBreakdownResponse,
  StatusBreakdownResponse,
} from '@/components/dashboard/types';
import { loadPeriod, savePeriod } from '@/components/dashboard/period-utils';
import { buildDashboardCsv, downloadCsv } from '@/components/dashboard/csv-export';

export default function DashboardPage() {
  const { t } = useT();

  // Restore the last-used period (default 30d); persist on every change.
  const [period, setPeriod] = React.useState<PeriodState>(() => loadPeriod());
  const [granularity, setGranularity] = React.useState<Granularity>('day');
  const [topBy, setTopBy] = React.useState<TopBy>('revenue');

  const handlePeriodChange = React.useCallback((p: PeriodState) => {
    setPeriod(p);
    savePeriod(p);
  }, []);

  // Build shared ISO params
  const rangeParams = `from=${encodeURIComponent(period.from + 'T00:00:00.000Z')}&to=${encodeURIComponent(period.to + 'T23:59:59.999Z')}`;

  const summaryQuery = useQuery<SummaryResponse>({
    queryKey: ['stats-summary', period.from, period.to],
    queryFn: () => apiFetch(`/admin/v1/stats/summary?${rangeParams}`),
    staleTime: 60_000,
  });

  const timeseriesQuery = useQuery<TimeseriesResponse>({
    queryKey: ['stats-timeseries', period.from, period.to, granularity],
    queryFn: () => apiFetch(`/admin/v1/stats/timeseries?${rangeParams}&granularity=${granularity}`),
    staleTime: 60_000,
  });

  const topProductsQuery = useQuery<TopProductsResponse>({
    queryKey: ['stats-top-products', period.from, period.to, topBy],
    queryFn: () => apiFetch(`/admin/v1/stats/top-products?${rangeParams}&limit=5&by=${topBy}`),
    staleTime: 60_000,
  });

  const attentionQuery = useQuery<AttentionResponse>({
    queryKey: ['stats-attention'],
    queryFn: () => apiFetch('/admin/v1/stats/attention'),
    staleTime: 120_000,
  });

  const customerBreakdownQuery = useQuery<CustomerBreakdownResponse>({
    queryKey: ['stats-customer-breakdown', period.from, period.to],
    queryFn: () => apiFetch(`/admin/v1/stats/customer-breakdown?${rangeParams}`),
    staleTime: 60_000,
  });

  const statusBreakdownQuery = useQuery<StatusBreakdownResponse>({
    queryKey: ['stats-status-breakdown', period.from, period.to],
    queryFn: () => apiFetch(`/admin/v1/stats/status-breakdown?${rangeParams}`),
    staleTime: 60_000,
  });

  const hasError = summaryQuery.error || timeseriesQuery.error || topProductsQuery.error;

  // CSV export is enabled once the data backing it has loaded.
  const canExport = !!summaryQuery.data || !!timeseriesQuery.data;
  const handleExport = React.useCallback(() => {
    const csv = buildDashboardCsv(summaryQuery.data, timeseriesQuery.data);
    downloadCsv(csv, period.from, period.to);
  }, [summaryQuery.data, timeseriesQuery.data, period.from, period.to]);

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-screen-2xl mx-auto">
      {/* Page header + period selector + export */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <h1 className="text-2xl font-semibold text-foreground">{t('dashboard', 'title')}</h1>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap">
          <PeriodSelector period={period} onChange={handlePeriodChange} />
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={!canExport}
            aria-label={t('dashboard', 'exportCsv')}
          >
            <Download className="h-4 w-4 mr-2" aria-hidden="true" />
            {t('dashboard', 'exportCsv')}
          </Button>
        </div>
      </div>

      {/* Global error banner (summary or timeseries failed) */}
      {hasError && (
        <Alert variant="destructive" role="alert">
          {t('dashboard', 'errorLoading')}
        </Alert>
      )}

      {/* KPI tiles (with sparklines derived from the timeseries) */}
      <KpiTiles
        data={summaryQuery.data}
        isLoading={summaryQuery.isLoading}
        timeseries={timeseriesQuery.data}
      />

      {/* Revenue + orders chart */}
      <RevenueChart
        data={timeseriesQuery.data}
        isLoading={timeseriesQuery.isLoading}
        granularity={granularity}
        onGranularityChange={setGranularity}
      />

      {/* Needs attention */}
      <AttentionRow data={attentionQuery.data} isLoading={attentionQuery.isLoading} />

      {/* Customer mix + order-status breakdown */}
      <div className="grid gap-6 lg:grid-cols-2">
        <CustomerBreakdown
          data={customerBreakdownQuery.data}
          isLoading={customerBreakdownQuery.isLoading}
        />
        <StatusDonut data={statusBreakdownQuery.data} isLoading={statusBreakdownQuery.isLoading} />
      </div>

      {/* Bottom two-column: top products + recent orders */}
      <div className="grid gap-6 lg:grid-cols-2">
        <TopProducts
          data={topProductsQuery.data}
          isLoading={topProductsQuery.isLoading}
          by={topBy}
          onByChange={setTopBy}
        />
        <RecentOrders />
      </div>
    </div>
  );
}
