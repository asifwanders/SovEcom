import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/lib/i18n-context';
import type { CustomerBreakdownResponse } from './types';

interface CustomerBreakdownProps {
  data: CustomerBreakdownResponse | undefined;
  isLoading: boolean;
}

// Read theme tokens at render so the bar tracks light/dark mode.
function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function CustomerBreakdown({ data, isLoading }: CustomerBreakdownProps) {
  const { t } = useT();

  const newCount = data?.newCustomers ?? 0;
  const returningCount = data?.returningCustomers ?? 0;
  const total = newCount + returningCount;

  const newPct = total > 0 ? (newCount / total) * 100 : 0;
  const returningPct = total > 0 ? (returningCount / total) * 100 : 0;

  const newColor = cssVar('--primary', '#00B9A0');
  const returningColor = cssVar('--muted-foreground', '#6B6660');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold">
          {t('dashboard', 'customersTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-4" aria-label="Loading customer breakdown">
            <Skeleton className="h-4 w-full rounded-full" />
            <div className="flex gap-6">
              <Skeleton className="h-12 w-24" />
              <Skeleton className="h-12 w-24" />
            </div>
          </div>
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground py-4">{t('dashboard', 'emptyPeriod')}</p>
        ) : (
          <div className="space-y-4">
            {/* Stacked proportion bar */}
            <div
              className="flex h-4 w-full overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${newCount} ${t('dashboard', 'customersNew')}, ${returningCount} ${t('dashboard', 'customersReturning')}`}
            >
              {newPct > 0 && <div style={{ width: `${newPct}%`, backgroundColor: newColor }} />}
              {returningPct > 0 && (
                <div style={{ width: `${returningPct}%`, backgroundColor: returningColor }} />
              )}
            </div>

            {/* Counts */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-start gap-2">
                <span
                  className="mt-1 h-3 w-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: newColor }}
                  aria-hidden="true"
                />
                <div>
                  <div className="text-2xl font-bold tabular-nums text-foreground">
                    {newCount.toLocaleString()}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('dashboard', 'customersNew')}
                    {total > 0 && ` · ${newPct.toFixed(0)}%`}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span
                  className="mt-1 h-3 w-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: returningColor }}
                  aria-hidden="true"
                />
                <div>
                  <div className="text-2xl font-bold tabular-nums text-foreground">
                    {returningCount.toLocaleString()}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('dashboard', 'customersReturning')}
                    {total > 0 && ` · ${returningPct.toFixed(0)}%`}
                  </p>
                </div>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">{t('dashboard', 'customersGuestNote')}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
