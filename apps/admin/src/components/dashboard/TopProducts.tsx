import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/lib/i18n-context';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { TopProductsResponse, TopBy } from './types';

interface TopProductsProps {
  data: TopProductsResponse | undefined;
  isLoading: boolean;
  by: TopBy;
  onByChange: (by: TopBy) => void;
}

export function TopProducts({ data, isLoading, by, onByChange }: TopProductsProps) {
  const { t } = useT();
  const currency = data?.currency ?? 'EUR';

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base font-semibold">
            {t('dashboard', 'topProductsTitle')}
          </CardTitle>
          <div
            role="group"
            aria-label="Sort top products by"
            className="inline-flex rounded-md border border-border bg-muted p-0.5 gap-0.5"
          >
            {(['revenue', 'quantity'] as TopBy[]).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => onByChange(opt)}
                aria-pressed={by === opt}
                className={cn(
                  'rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  by === opt
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t('dashboard', opt === 'revenue' ? 'byRevenue' : 'byQuantity')}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3" aria-label="Loading top products">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        ) : !data || data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">{t('dashboard', 'emptyProducts')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={t('dashboard', 'topProductsTitle')}>
              <thead>
                <tr className="border-b border-border">
                  <th className="pb-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t('dashboard', 'colProduct')}
                  </th>
                  <th className="pb-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide w-20">
                    {t('dashboard', 'colQty')}
                  </th>
                  <th className="pb-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide w-28">
                    {t('dashboard', 'colRevenue')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.items.map((item, i) => (
                  <tr
                    key={`${item.productTitle}-${item.variantId ?? i}`}
                    className="hover:bg-muted/40"
                  >
                    <td className="py-2.5 pr-3 font-medium text-foreground truncate max-w-[200px]">
                      {item.productTitle}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                      {item.quantitySold.toLocaleString()}
                    </td>
                    <td className="py-2.5 text-right tabular-nums font-medium">
                      {formatMoney(item.revenue, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
