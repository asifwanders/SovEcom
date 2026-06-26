import React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Mail, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';

type EmailStatus = 'sent' | 'failed';
type EmailType = 'order_confirmation' | 'order_shipped' | 'refund_issued';

interface EmailLog {
  id: string;
  recipient: string;
  type: EmailType;
  subject: string;
  status: EmailStatus;
  attempts: number;
  error: string | null;
  providerMessageId: string | null;
  sentAt: string | null;
  createdAt: string;
}

interface EmailLogResponse {
  data: EmailLog[];
  total: number;
  page: number;
  pageSize: number;
}

const TYPE_LABELS: Record<EmailType, string> = {
  order_confirmation: 'Order confirmation',
  order_shipped: 'Order shipped',
  refund_issued: 'Refund issued',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function EmailLogPage() {
  const [page, setPage] = React.useState(1);
  const [statusFilter, setStatusFilter] = React.useState<string>('');
  const [typeFilter, setTypeFilter] = React.useState<string>('');

  const { data, isLoading, refetch } = useQuery<EmailLogResponse>({
    queryKey: ['emails', page, statusFilter, typeFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (statusFilter) params.set('status', statusFilter);
      if (typeFilter) params.set('type', typeFilter);
      return apiFetch(`/admin/v1/emails?${params.toString()}`);
    },
  });

  const resendMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/v1/emails/${id}/resend`, { method: 'POST' }),
    onSuccess: () => refetch(),
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[{ label: t('layout', 'dashboard'), to: '/dashboard' }, { label: 'Email log' }]}
      />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Mail className="h-6 w-6" aria-hidden="true" />
          Email log
        </h1>
      </div>

      <div className="flex items-center gap-3">
        <Select
          aria-label="Status filter"
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </Select>
        <Select
          aria-label="Type filter"
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All types</option>
          <option value="order_confirmation">Order confirmation</option>
          <option value="order_shipped">Order shipped</option>
          <option value="refund_issued">Refund issued</option>
        </Select>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Recipient</th>
              <th className="px-4 py-3 text-left font-medium">Type</th>
              <th className="px-4 py-3 text-left font-medium">Subject</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Attempts</th>
              <th className="px-4 py-3 text-left font-medium">Sent at</th>
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
                  No emails found.
                </td>
              </tr>
            ) : (
              data?.data.map((email) => (
                <tr key={email.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3 font-medium">{email.recipient}</td>
                  <td className="px-4 py-3">{TYPE_LABELS[email.type] ?? email.type}</td>
                  <td className="px-4 py-3">{email.subject}</td>
                  <td className="px-4 py-3">
                    <Badge variant={email.status === 'sent' ? 'success' : 'destructive'}>
                      {email.status === 'sent' ? 'Sent' : 'Failed'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">{email.attempts}</td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(email.sentAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {email.status === 'failed' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => resendMutation.mutate(email.id)}
                        isLoading={
                          resendMutation.isPending && resendMutation.variables === email.id
                        }
                      >
                        <RefreshCw className="h-4 w-4 mr-1" aria-hidden="true" />
                        Resend
                      </Button>
                    )}
                  </td>
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
            {data?.total} emails
          </p>
          <div className="flex items-center gap-2">
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
        </div>
      )}
    </div>
  );
}
