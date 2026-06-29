import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/lib/i18n-context';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { Granularity, TimeseriesResponse } from './types';
import { formatBucket } from './period-utils';

interface RevenueChartProps {
  data: TimeseriesResponse | undefined;
  isLoading: boolean;
  granularity: Granularity;
  onGranularityChange: (g: Granularity) => void;
}

const GRANULARITIES: Granularity[] = ['day', 'week', 'month'];

// Read CSS variable values at runtime so Recharts colours respect the current theme
function cssVar(name: string): string {
  if (typeof window === 'undefined') return '#00B9A0';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#00B9A0';
}

interface TooltipPayloadEntry {
  name: string;
  value: number;
  color: string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  currency: string;
  granularity: Granularity;
  revenueLabel: string;
  ordersLabel: string;
}

function CustomTooltip({
  active,
  payload,
  label,
  currency,
  granularity,
  revenueLabel,
  ordersLabel,
}: CustomTooltipProps) {
  if (!active || !payload || !label) return null;
  const formatted = formatBucket(label, granularity);
  return (
    <div
      role="tooltip"
      className="rounded-lg border border-border bg-card text-card-foreground shadow-md px-3 py-2 text-sm"
    >
      <p className="font-medium mb-1">{formatted}</p>
      {payload.map((entry) => (
        <p key={entry.name} style={{ color: entry.color }}>
          {entry.name === 'revenue'
            ? `${revenueLabel}: ${formatMoney(entry.value, currency)}`
            : `${ordersLabel}: ${entry.value.toLocaleString()}`}
        </p>
      ))}
    </div>
  );
}

export function RevenueChart({
  data,
  isLoading,
  granularity,
  onGranularityChange,
}: RevenueChartProps) {
  const { t } = useT();

  const granLabel = (g: Granularity) => {
    const map: Record<Granularity, string> = {
      day: t('dashboard', 'granularityDay'),
      week: t('dashboard', 'granularityWeek'),
      month: t('dashboard', 'granularityMonth'),
    };
    return map[g];
  };

  const revenueLabel = t('dashboard', 'revenueAxis');
  const ordersLabel = t('dashboard', 'ordersAxis');
  const currency = data?.currency ?? 'EUR';

  // Derive theme-aware colours at render time
  const primaryColor = cssVar('--primary');
  const mutedColor = cssVar('--muted-foreground');
  const borderColor = cssVar('--border');

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-semibold">
            {t('dashboard', 'revenueChartTitle')}
          </CardTitle>
          {/* Granularity segmented control */}
          <div
            role="group"
            aria-label="Chart granularity"
            className="inline-flex rounded-md border border-border bg-muted p-0.5 gap-0.5"
          >
            {GRANULARITIES.map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => onGranularityChange(g)}
                aria-pressed={granularity === g}
                className={cn(
                  'rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  granularity === g
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {granLabel(g)}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : !data || data.points.length === 0 ? (
          <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
            {t('dashboard', 'emptyPeriod')}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={224}>
            <ComposedChart
              data={data.points}
              margin={{ top: 4, right: 16, left: 0, bottom: 0 }}
              aria-label={`${revenueLabel} and ${ordersLabel} chart`}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={borderColor} vertical={false} />
              <XAxis
                dataKey="bucket"
                tick={{ fill: mutedColor, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: string) => formatBucket(v, granularity)}
                interval="preserveStartEnd"
              />
              {/* Left axis — revenue */}
              <YAxis
                yAxisId="revenue"
                orientation="left"
                tick={{ fill: mutedColor, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => formatMoney(v, currency)}
                width={80}
                aria-label={revenueLabel}
              />
              {/* Right axis — orders */}
              <YAxis
                yAxisId="orders"
                orientation="right"
                tick={{ fill: mutedColor, fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={40}
                aria-label={ordersLabel}
              />
              <Tooltip
                content={
                  <CustomTooltip
                    currency={currency}
                    granularity={granularity}
                    revenueLabel={revenueLabel}
                    ordersLabel={ordersLabel}
                  />
                }
              />
              <Legend
                formatter={(value: string) => (value === 'revenue' ? revenueLabel : ordersLabel)}
                wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
              />
              <Bar
                yAxisId="revenue"
                dataKey="revenue"
                name="revenue"
                fill={primaryColor}
                radius={[3, 3, 0, 0]}
                maxBarSize={40}
              />
              <Line
                yAxisId="orders"
                dataKey="orders"
                name="orders"
                type="monotone"
                stroke={mutedColor}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
