import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';

interface Dispute {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  reason: string | null;
  status: string;
  providerStatus: string | null;
  evidenceDueBy: string | null;
  providerDisputeId: string | null;
  createdAt: string;
}

interface DisputeListResponse {
  data: Dispute[];
  total: number;
  page: number;
  pageSize: number;
}

const DISPUTE_STATUSES = ['open', 'won', 'lost'];

const disputeStatusVariant: Record<string, BadgeProps['variant']> = {
  open: 'warning',
  won: 'success',
  lost: 'destructive',
};

export default function DisputesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // UX-only gating — server enforces real authorization. Unfreeze is an order
  // lifecycle action (orders:write / admin+), so staff (orders:read) must not see it.
  const role = useAuthStore((s) => s.user?.role ?? null);
  const canWrite = can(role, 'orders:write');

  const [page, setPage] = React.useState(1);
  const [statusFilter, setStatusFilter] = React.useState('');
  const [confirmUnfreeze, setConfirmUnfreeze] = React.useState<Dispute | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const { data, isLoading, error } = useQuery<DisputeListResponse>({
    queryKey: ['disputes', page, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (statusFilter) params.set('status', statusFilter);
      return apiFetch(`/admin/v1/disputes?${params.toString()}`);
    },
  });

  const unfreeze = useMutation({
    mutationFn: (disputeId: string) =>
      apiFetch(`/admin/v1/disputes/${disputeId}/unfreeze-fulfillment`, { method: 'POST' }),
    onSuccess: () => {
      setConfirmUnfreeze(null);
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['disputes'] });
    },
    onError: (e: unknown) =>
      setActionError(e instanceof ApiError ? e.message : t('common', 'genericError')),
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[{ label: t('layout', 'dashboard'), to: '/dashboard' }, { label: 'Disputes' }]}
      />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <AlertTriangle className="h-6 w-6" aria-hidden="true" />
          Disputes
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
          {DISPUTE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>

      {error && <Alert variant="destructive">{t('common', 'genericError')}</Alert>}
      {actionError && <Alert variant="destructive">{actionError}</Alert>}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Order</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Reason</th>
              <th className="px-4 py-3 text-left font-medium">Evidence due</th>
              {canWrite && <th className="px-4 py-3 text-right font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td
                  colSpan={canWrite ? 6 : 5}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  {t('common', 'loading')}
                </td>
              </tr>
            ) : data?.data.length === 0 ? (
              <tr>
                <td
                  colSpan={canWrite ? 6 : 5}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  No disputes found.
                </td>
              </tr>
            ) : (
              data?.data.map((dispute) => (
                <tr
                  key={dispute.id}
                  className="hover:bg-muted/50 cursor-pointer"
                  onClick={() => navigate(`/orders/${dispute.orderId}`)}
                >
                  <td className="px-4 py-3 font-medium">
                    <span className="text-primary underline-offset-2 hover:underline">
                      {dispute.orderId}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {formatMoney(dispute.amount, dispute.currency)}
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={disputeStatusVariant[dispute.status] ?? 'default'}
                      className="capitalize"
                    >
                      {dispute.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{dispute.reason ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {dispute.evidenceDueBy
                      ? new Date(dispute.evidenceDueBy).toLocaleDateString()
                      : '—'}
                  </td>
                  {canWrite && (
                    <td className="px-4 py-3 text-right">
                      {/* Only open disputes can have a frozen order to release; won/lost are closed. */}
                      {dispute.status === 'open' && (
                        <Button
                          variant="outline"
                          size="sm"
                          // Stop the row navigation when opening the confirm dialog.
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmUnfreeze(dispute);
                          }}
                        >
                          Unfreeze fulfilment
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {((data?.page ?? 1) - 1) * (data?.pageSize ?? 20) + 1}–
            {Math.min((data?.page ?? 1) * (data?.pageSize ?? 20), data?.total ?? 0)} of{' '}
            {data?.total} disputes
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              aria-label="Previous page"
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
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={!!confirmUnfreeze}
        onClose={() => {
          setConfirmUnfreeze(null);
          setActionError(null);
        }}
        title="Unfreeze fulfilment"
        description="This releases the order's frozen fulfilment while the dispute is still open. Only do this if you intend to ship despite an unresolved dispute. Continue?"
      >
        <div className="space-y-4 mt-2">
          {actionError && <Alert variant="destructive">{actionError}</Alert>}
          {confirmUnfreeze && (
            <p className="text-sm text-muted-foreground">
              Order {confirmUnfreeze.orderId} ·{' '}
              {formatMoney(confirmUnfreeze.amount, confirmUnfreeze.currency)} disputed.
            </p>
          )}
          <div className="flex items-center justify-end gap-3">
            <Button variant="secondary" onClick={() => setConfirmUnfreeze(null)}>
              {t('common', 'cancel')}
            </Button>
            <Button
              variant="destructive"
              isLoading={unfreeze.isPending}
              onClick={() => confirmUnfreeze && unfreeze.mutate(confirmUnfreeze.id)}
            >
              Unfreeze fulfilment
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
