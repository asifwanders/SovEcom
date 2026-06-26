import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { ShoppingCart, ChevronLeft, ChevronRight, Snowflake } from 'lucide-react';

interface Order {
  id: string;
  orderNumber: string;
  email: string;
  status: string;
  currency: string;
  totalAmount: number;
  refundedAmount: number;
  fulfillmentFrozen: boolean;
  createdAt: string;
}

interface OrderListResponse {
  data: Order[];
  total: number;
  page: number;
  pageSize: number;
}

const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'fulfilled',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
];

export const orderStatusVariant: Record<string, BadgeProps['variant']> = {
  pending_payment: 'secondary',
  paid: 'success',
  fulfilled: 'default',
  shipped: 'default',
  delivered: 'success',
  cancelled: 'destructive',
  refunded: 'warning',
  partially_refunded: 'warning',
};

export default function OrdersPage() {
  const navigate = useNavigate();
  const [page, setPage] = React.useState(1);
  const [statusFilter, setStatusFilter] = React.useState('');

  const { data, isLoading, error } = useQuery<OrderListResponse>({
    queryKey: ['orders', page, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (statusFilter) params.set('status', statusFilter);
      return apiFetch(`/admin/v1/orders?${params.toString()}`);
    },
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'orders') },
        ]}
      />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShoppingCart className="h-6 w-6" aria-hidden="true" />
          {t('layout', 'orders')}
        </h1>
      </div>

      <div className="flex items-center gap-3">
        <Select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, ' ')}
            </option>
          ))}
        </Select>
      </div>

      {error && <Alert variant="destructive">{t('common', 'genericError')}</Alert>}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Order</th>
              <th className="px-4 py-3 text-left font-medium">Email</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Total</th>
              <th className="px-4 py-3 text-right font-medium">Refunded</th>
              <th className="px-4 py-3 text-left font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {t('common', 'loading')}
                </td>
              </tr>
            ) : data?.data.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No orders found.
                </td>
              </tr>
            ) : (
              data?.data.map((order) => (
                <tr
                  key={order.id}
                  className="hover:bg-muted/50 cursor-pointer"
                  onClick={() => navigate(`/orders/${order.id}`)}
                >
                  <td className="px-4 py-3 font-medium">
                    <span className="flex items-center gap-2">
                      {order.orderNumber}
                      {order.fulfillmentFrozen && (
                        <Snowflake
                          className="h-4 w-4 text-blue-500"
                          aria-label="Fulfillment frozen"
                        />
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{order.email}</td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={orderStatusVariant[order.status] ?? 'default'}
                      className="capitalize"
                    >
                      {order.status.replace(/_/g, ' ')}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {formatMoney(order.totalAmount, order.currency)}
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {order.refundedAmount > 0
                      ? formatMoney(order.refundedAmount, order.currency)
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(order.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
