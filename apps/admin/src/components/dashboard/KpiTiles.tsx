import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Sparkline } from './Sparkline';
import { useT } from '@/lib/i18n-context';
import { formatMoney } from '@/lib/money';
import type { SummaryResponse, MetricValue, TimeseriesResponse } from './types';

interface KpiTilesProps {
  data: SummaryResponse | undefined;
  isLoading: boolean;
  /** Timeseries powering the per-tile sparklines. AOV is derived client-side. */
  timeseries?: TimeseriesResponse;
}

type KpiKey = keyof SummaryResponse['metrics'];

interface KpiSpec {
  key: KpiKey;
  labelKey: string;
  format: (value: number, currency: string) => string;
  /** extra help text to append below the value */
  hintKey?: string;
  /**
   * Derive the sparkline series from the timeseries points. Omit for metrics
   * with no per-bucket series (return-rate, cart-conversion).
   */
  series?: (points: TimeseriesResponse['points']) => number[];
}

const KPI_SPECS: KpiSpec[] = [
  {
    key: 'netRevenue',
    labelKey: 'kpiNetRevenue',
    format: (v, cur) => formatMoney(v, cur),
    series: (pts) => pts.map((p) => p.revenue),
  },
  {
    key: 'orders',
    labelKey: 'kpiOrders',
    format: (v) => v.toLocaleString(),
    series: (pts) => pts.map((p) => p.orders),
  },
  {
    key: 'averageOrderValue',
    labelKey: 'kpiAov',
    format: (v, cur) => formatMoney(v, cur),
    // AOV per bucket = revenue / orders (guard /0), derived client-side.
    series: (pts) => pts.map((p) => (p.orders > 0 ? Math.round(p.revenue / p.orders) : 0)),
  },
  {
    key: 'newCustomers',
    labelKey: 'kpiNewCustomers',
    format: (v) => v.toLocaleString(),
    series: (pts) => pts.map((p) => p.newCustomers),
  },
  {
    key: 'returnRate',
    labelKey: 'kpiReturnRate',
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'refunds',
    labelKey: 'kpiRefunds',
    format: (v, cur) => formatMoney(v, cur),
    series: (pts) => pts.map((p) => p.refundAmount),
  },
  {
    key: 'cartConversion',
    labelKey: 'kpiCartConversion',
    format: (v) => `${(v * 100).toFixed(1)}%`,
    hintKey: 'kpiCartConversionHint',
  },
];

function DeltaBadge({ metric }: { metric: MetricValue }) {
  const { deltaPct } = metric;
  if (deltaPct === null) {
    return (
      <span
        aria-label="No comparison data"
        className="inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground"
      >
        <Minus className="h-3 w-3" aria-hidden="true" />—
      </span>
    );
  }
  const positive = deltaPct >= 0;
  return (
    <span
      aria-label={`${positive ? 'Up' : 'Down'} ${Math.abs(deltaPct)}% vs previous period`}
      className={`inline-flex items-center gap-0.5 text-xs font-medium ${
        positive ? 'text-success' : 'text-destructive'
      }`}
    >
      {positive ? (
        <TrendingUp className="h-3 w-3" aria-hidden="true" />
      ) : (
        <TrendingDown className="h-3 w-3" aria-hidden="true" />
      )}
      {positive ? '+' : ''}
      {deltaPct.toFixed(1)}%
    </span>
  );
}

export function KpiTiles({ data, isLoading, timeseries }: KpiTilesProps) {
  const { t } = useT();
  const currency = data?.currency ?? 'EUR';
  const points = timeseries?.points ?? [];

  if (isLoading) {
    return (
      <div
        className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7"
        aria-label="Loading KPI tiles"
      >
        {KPI_SPECS.map((spec) => (
          <Card key={spec.key}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-20 mb-1" />
              <Skeleton className="h-4 w-14" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div
      className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7"
      role="list"
      aria-label="Key performance indicators"
    >
      {KPI_SPECS.map((spec) => {
        const metric = data?.metrics[spec.key];
        const displayValue = metric ? spec.format(metric.value, currency) : '—';
        const label = t('dashboard', spec.labelKey as Parameters<typeof t>[1]);
        const hint = spec.hintKey
          ? t('dashboard', spec.hintKey as Parameters<typeof t>[1])
          : undefined;
        const sparkData = spec.series ? spec.series(points) : undefined;

        return (
          <Card key={spec.key} role="listitem">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div
                className="text-xl font-bold text-foreground truncate"
                aria-label={`${label}: ${displayValue}`}
              >
                {displayValue}
              </div>
              {metric ? (
                <div className="mt-1">
                  <DeltaBadge metric={metric} />
                </div>
              ) : (
                <div className="mt-1 h-4" />
              )}
              {hint && <p className="mt-1 text-xs text-muted-foreground leading-tight">{hint}</p>}
              {sparkData && sparkData.length > 0 && (
                <div className="mt-2">
                  <Sparkline
                    data={sparkData}
                    ariaLabel={`${label} trend over the selected period`}
                  />
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
