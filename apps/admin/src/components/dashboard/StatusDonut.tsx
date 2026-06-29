import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/lib/i18n-context';
import type { StatusBreakdownResponse } from './types';

interface StatusDonutProps {
  data: StatusBreakdownResponse | undefined;
  isLoading: boolean;
}

// Map each order status to a theme CSS variable. Mirrors the orders-page Badge
// intent (paid/delivered/completed = success teal-ish, cancelled = destructive,
// refunds = warning) but resolved to concrete colors so Recharts can paint cells.
const STATUS_TOKEN: Record<string, string> = {
  pending_payment: '--muted-foreground',
  paid: '--info',
  fulfilled: '--primary',
  shipped: '--info',
  delivered: '--success',
  completed: '--success',
  cancelled: '--destructive',
  refunded: '--warning',
  partially_refunded: '--warning',
};

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function statusColor(status: string): string {
  return cssVar(STATUS_TOKEN[status] ?? '--muted-foreground', '#6B6660');
}

function humanize(status: string): string {
  return status.replace(/_/g, ' ');
}

interface TooltipEntry {
  name: string;
  value: number;
  payload: { status: string; count: number };
}

function DonutTooltip({ active, payload }: { active?: boolean; payload?: TooltipEntry[] }) {
  if (!active || !payload || !payload.length) return null;
  const { status, count } = payload[0]!.payload;
  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground shadow-md px-3 py-2 text-sm">
      <span className="capitalize font-medium">{humanize(status)}</span>: {count.toLocaleString()}
    </div>
  );
}

export function StatusDonut({ data, isLoading }: StatusDonutProps) {
  const { t } = useT();

  const statuses = data?.statuses ?? [];
  const total = statuses.reduce((sum, s) => sum + s.count, 0);
  const nonEmpty = statuses.filter((s) => s.count > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold">
          {t('dashboard', 'statusDonutTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-6" aria-label="Loading status breakdown">
            <Skeleton className="h-36 w-36 rounded-full" />
            <div className="flex-1 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          </div>
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground py-4">{t('dashboard', 'emptyPeriod')}</p>
        ) : (
          <div className="flex flex-col items-center gap-6 sm:flex-row">
            {/* Donut */}
            <div
              className="h-40 w-40 shrink-0"
              role="img"
              aria-label={t('dashboard', 'statusDonutTitle')}
            >
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={nonEmpty}
                    dataKey="count"
                    nameKey="status"
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={70}
                    paddingAngle={1}
                    isAnimationActive={false}
                    stroke="none"
                  >
                    {nonEmpty.map((entry) => (
                      <Cell key={entry.status} fill={statusColor(entry.status)} />
                    ))}
                  </Pie>
                  <Tooltip content={<DonutTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            {/* Legend with counts — show all 9 statuses, dimmed when zero */}
            <ul className="grid flex-1 grid-cols-1 gap-1.5 text-sm sm:grid-cols-2 w-full">
              {statuses.map((s) => {
                const pct = total > 0 ? (s.count / total) * 100 : 0;
                return (
                  <li
                    key={s.status}
                    className={`flex items-center justify-between gap-2 ${
                      s.count === 0 ? 'opacity-50' : ''
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: statusColor(s.status) }}
                        aria-hidden="true"
                      />
                      <span className="capitalize truncate text-muted-foreground">
                        {humanize(s.status)}
                      </span>
                    </span>
                    <span className="tabular-nums font-medium text-foreground whitespace-nowrap">
                      {s.count.toLocaleString()}
                      {s.count > 0 && (
                        <span className="text-muted-foreground font-normal ml-1">
                          ({pct.toFixed(0)}%)
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
