import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useT } from '@/lib/i18n-context';
import { apiFetch } from '@/lib/api';
import { formatMoney } from '@/lib/money';

interface Order {
  id: string;
  orderNumber: string;
  email: string;
  status: string;
  currency: string;
  totalAmount: number;
  createdAt: string;
}

interface OrderListResponse {
  data: Order[];
  total: number;
  page: number;
  pageSize: number;
}

const STATUS_VARIANT: Record<string, BadgeProps['variant']> = {
  pending_payment: 'secondary',
  paid: 'success',
  fulfilled: 'default',
  shipped: 'default',
  delivered: 'success',
  cancelled: 'destructive',
  refunded: 'warning',
  partially_refunded: 'warning',
  completed: 'success',
};

export function RecentOrders() {
  const { t } = useT();
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery<OrderListResponse>({
    queryKey: ['orders-recent'],
    queryFn: () => apiFetch('/admin/v1/orders?pageSize=5'),
    staleTime: 60_000,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold">
          {t('dashboard', 'recentOrdersTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {error ? (
          <Alert variant="destructive">{t('dashboard', 'errorLoading')}</Alert>
        ) : isLoading ? (
          <div className="space-y-3" aria-label="Loading recent orders">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        ) : !data || data.data.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">{t('dashboard', 'emptyOrders')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label={t('dashboard', 'recentOrdersTitle')}>
              <thead>
                <tr className="border-b border-border">
                  <th className="pb-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t('dashboard', 'colOrder')}
                  </th>
                  <th className="pb-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide hidden sm:table-cell">
                    {t('dashboard', 'colEmail')}
                  </th>
                  <th className="pb-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t('dashboard', 'colStatus')}
                  </th>
                  <th className="pb-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {t('dashboard', 'colTotal')}
                  </th>
                  <th className="pb-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide hidden md:table-cell">
                    {t('dashboard', 'colDate')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.data.map((order) => (
                  <tr
                    key={order.id}
                    className="hover:bg-muted/40 cursor-pointer"
                    onClick={() => navigate(`/orders/${order.id}`)}
                    tabIndex={0}
                    role="link"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigate(`/orders/${order.id}`);
                      }
                    }}
                    aria-label={`Order ${order.orderNumber}, ${order.status}, ${formatMoney(order.totalAmount, order.currency)}`}
                  >
                    <td className="py-2.5 pr-3 font-medium text-foreground">{order.orderNumber}</td>
                    <td className="py-2.5 pr-3 text-muted-foreground hidden sm:table-cell truncate max-w-[150px]">
                      {order.email}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge
                        variant={STATUS_VARIANT[order.status] ?? 'default'}
                        className="capitalize whitespace-nowrap"
                      >
                        {order.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td className="py-2.5 text-right tabular-nums font-medium">
                      {formatMoney(order.totalAmount, order.currency)}
                    </td>
                    <td className="py-2.5 text-right text-muted-foreground hidden md:table-cell whitespace-nowrap">
                      {new Date(order.createdAt).toLocaleDateString()}
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
