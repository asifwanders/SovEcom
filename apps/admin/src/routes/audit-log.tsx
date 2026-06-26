import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { ClipboardList, Search, ChevronLeft, ChevronRight, Download } from 'lucide-react';

interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  changes: unknown;
}

interface AuditListResponse {
  data: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export default function AuditLogPage() {
  // UX-only gating — server enforces real authorization.
  const role = useAuthStore((s) => s.user?.role ?? null);
  const canExport = can(role, 'audit_log:export');
  const [page, setPage] = React.useState(1);
  const [actionFilter, setActionFilter] = React.useState('');
  const [resourceTypeFilter, setResourceTypeFilter] = React.useState('');
  const [dateFrom, setDateFrom] = React.useState('');
  const [dateTo, setDateTo] = React.useState('');

  const { data, isLoading } = useQuery<AuditListResponse>({
    queryKey: ['audit-log', page, actionFilter, resourceTypeFilter, dateFrom, dateTo],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (actionFilter) params.set('action', actionFilter);
      if (resourceTypeFilter) params.set('resourceType', resourceTypeFilter);
      if (dateFrom) params.set('dateFrom', dateFrom);
      if (dateTo) params.set('dateTo', dateTo);
      return apiFetch(`/admin/v1/audit-log?${params.toString()}`);
    },
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  async function handleExport() {
    const params = new URLSearchParams();
    if (actionFilter) params.set('action', actionFilter);
    if (resourceTypeFilter) params.set('resourceType', resourceTypeFilter);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    // Default to last 7 days if no dates provided
    if (!dateFrom && !dateTo) {
      const to = new Date().toISOString().split('T')[0]!;
      const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!;
      params.set('dateFrom', from);
      params.set('dateTo', to);
    }
    const url = `/admin/v1/audit-log/export?${params.toString()}`;
    const response = await apiFetch<string>(url);
    // Download CSV
    const blob = new Blob([response], { type: 'text/csv' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `audit-log-${Date.now()}.csv`;
    link.click();
    // Release the object URL after the browser picks it up
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'auditLog') },
        ]}
      />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ClipboardList className="h-6 w-6" aria-hidden="true" />
          {t('layout', 'auditLog')}
        </h1>
        {/* UX-only: export is owner/admin only; server enforces */}
        {canExport && (
          <Button variant="outline" onClick={handleExport}>
            <Download className="h-4 w-4 mr-2" /> Export CSV
          </Button>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative max-w-xs">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            placeholder="Action..."
            className="pl-9"
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select
          value={resourceTypeFilter}
          onChange={(e) => {
            setResourceTypeFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All resources</option>
          <option value="product">Product</option>
          <option value="customer">Customer</option>
          <option value="order">Order</option>
          <option value="category">Category</option>
          <option value="tag">Tag</option>
        </Select>
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => {
            setDateFrom(e.target.value);
            setPage(1);
          }}
        />
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => {
            setDateTo(e.target.value);
            setPage(1);
          }}
        />
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Time</th>
              <th className="px-4 py-3 text-left font-medium">Action</th>
              <th className="px-4 py-3 text-left font-medium">Resource</th>
              <th className="px-4 py-3 text-left font-medium">Actor</th>
              <th className="px-4 py-3 text-left font-medium">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  {t('common', 'loading')}
                </td>
              </tr>
            ) : data?.data.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  No audit entries found.
                </td>
              </tr>
            ) : (
              data?.data.map((entry) => (
                <tr key={entry.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3 whitespace-nowrap">
                    {new Date(entry.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-primary/10 text-primary">
                      {entry.action}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {entry.resourceType}
                    {entry.resourceId && (
                      <span className="text-xs text-muted-foreground ml-1">
                        ({entry.resourceId.slice(0, 8)}…)
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {entry.actorId?.slice(0, 8) ?? '—'}…
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{entry.ipAddress ?? '—'}</td>
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
            {data?.total} entries
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
