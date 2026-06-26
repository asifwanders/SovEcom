import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';

interface ReturnItem {
  orderItemId: string;
  quantity: number;
}
interface ReturnRow {
  id: string;
  orderId: string;
  type: string;
  status: string;
  items: ReturnItem[];
  reason: string | null;
  withinWithdrawalWindow: boolean;
  requestedAt: string;
}
interface ReturnsResponse {
  data: ReturnRow[];
  total: number;
  page: number;
  pageSize: number;
}

const statusVariant: Record<string, BadgeProps['variant']> = {
  requested: 'secondary',
  approved: 'default',
  refunded: 'success',
  rejected: 'destructive',
};

export default function ReturnsPage() {
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canWrite = can(role, 'orders:write');

  const [page, setPage] = React.useState(1);
  const [statusFilter, setStatusFilter] = React.useState('');
  const [rejectId, setRejectId] = React.useState<string | null>(null);
  const [rejectReason, setRejectReason] = React.useState('');
  const [approveId, setApproveId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const { data, isLoading, error } = useQuery<ReturnsResponse>({
    queryKey: ['returns', page, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (statusFilter) params.set('status', statusFilter);
      return apiFetch(`/admin/v1/returns?${params.toString()}`);
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['returns'] });

  const approve = useMutation({
    mutationFn: (rid: string) => apiFetch(`/admin/v1/returns/${rid}/approve`, { method: 'POST' }),
    onSuccess: () => {
      setActionError(null);
      void invalidate();
    },
    onError: (e: unknown) =>
      setActionError(e instanceof ApiError ? e.message : t('common', 'genericError')),
  });

  const reject = useMutation({
    mutationFn: (vars: { rid: string; reason: string }) =>
      apiFetch(`/admin/v1/returns/${vars.rid}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: vars.reason }),
      }),
    onSuccess: () => {
      setRejectId(null);
      setRejectReason('');
      setActionError(null);
      void invalidate();
    },
    onError: (e: unknown) =>
      setActionError(e instanceof ApiError ? e.message : t('common', 'genericError')),
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'returns') },
        ]}
      />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <RotateCcw className="h-6 w-6" aria-hidden="true" />
          {t('layout', 'returns')}
        </h1>
        <Select
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="requested">Requested</option>
          <option value="approved">Approved</option>
          <option value="refunded">Refunded</option>
          <option value="rejected">Rejected</option>
        </Select>
      </div>

      {(error || actionError) && (
        <Alert variant="destructive">{actionError ?? t('common', 'genericError')}</Alert>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Type</th>
              <th className="px-4 py-3 text-left font-medium">Items</th>
              <th className="px-4 py-3 text-left font-medium">Reason</th>
              <th className="px-4 py-3 text-left font-medium">Window</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Requested</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  {t('common', 'loading')}
                </td>
              </tr>
            ) : data?.data.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  No returns found.
                </td>
              </tr>
            ) : (
              data?.data.map((r) => (
                <tr key={r.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3 capitalize">{r.type}</td>
                  <td className="px-4 py-3">{r.items.reduce((n, i) => n + i.quantity, 0)}</td>
                  <td className="px-4 py-3 text-muted-foreground max-w-[16rem] truncate">
                    {r.reason ?? '—'}
                  </td>
                  <td className="px-4 py-3">
                    {r.type === 'withdrawal' ? (
                      <Badge variant={r.withinWithdrawalWindow ? 'success' : 'warning'}>
                        {r.withinWithdrawalWindow ? 'In window' : 'Out of window'}
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={statusVariant[r.status] ?? 'default'} className="capitalize">
                      {r.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(r.requestedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canWrite && r.status === 'requested' ? (
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={approve.isPending}
                          onClick={() => setApproveId(r.id)}
                        >
                          Approve
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setRejectId(r.id)}>
                          Reject
                        </Button>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
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

      <Dialog
        open={!!approveId}
        onClose={() => setApproveId(null)}
        title="Approve return"
        description="This will immediately issue a refund. This action cannot be undone."
      >
        <div className="flex items-center justify-end gap-3 mt-4">
          <Button variant="secondary" onClick={() => setApproveId(null)}>
            {t('common', 'cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={approve.isPending}
            onClick={() => {
              if (approveId) {
                approve.mutate(approveId);
                setApproveId(null);
              }
            }}
          >
            Confirm
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={!!rejectId}
        onClose={() => setRejectId(null)}
        title="Reject return"
        description="The customer's return request will be rejected. Provide a reason."
      >
        <div className="space-y-3 mt-2">
          <div>
            <Label htmlFor="reject-reason">Reason</Label>
            <Input
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. outside policy"
            />
          </div>
          <div className="flex items-center justify-end gap-3">
            <Button variant="secondary" onClick={() => setRejectId(null)}>
              {t('common', 'cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={!rejectReason.trim() || reject.isPending}
              onClick={() =>
                rejectId && reject.mutate({ rid: rejectId, reason: rejectReason.trim() })
              }
            >
              Reject
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
