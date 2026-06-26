import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Users, Search, ChevronLeft, ChevronRight, Eye, Trash2 } from 'lucide-react';

interface Customer {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  isB2b: boolean;
  vatNumber: string | null;
  vatValidated: boolean;
  taxExempt: boolean;
  acceptsMarketing: boolean;
  createdAt: string;
  updatedAt: string;
  anonymizedAt: string | null;
}

interface CustomerListResponse {
  data: Customer[];
  total: number;
  page: number;
  pageSize: number;
}

export default function CustomersPage() {
  // UX-only gating — server enforces real authorization.
  const role = useAuthStore((s) => s.user?.role ?? null);
  const canWrite = can(role, 'customers:write');
  const navigate = useNavigate();
  const [page, setPage] = React.useState(1);
  const [emailFilter, setEmailFilter] = React.useState('');
  const [b2bFilter, setB2bFilter] = React.useState<string>('');
  const [eraseId, setEraseId] = React.useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery<CustomerListResponse>({
    queryKey: ['customers', page, emailFilter, b2bFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (emailFilter) params.set('email', emailFilter);
      if (b2bFilter) params.set('isB2b', b2bFilter);
      return apiFetch(`/admin/v1/customers?${params.toString()}`);
    },
  });

  const eraseMutation = useMutation({
    mutationFn: async () => {
      if (!eraseId) return;
      await apiFetch(`/admin/v1/customers/${eraseId}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmEmail }),
      });
    },
    onSuccess: () => {
      setEraseId(null);
      setConfirmEmail('');
      refetch();
    },
    onError: () => {
      setError(
        "Erase failed. Please ensure the confirmation email matches the customer's current email.",
      );
    },
  });

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'customers') },
        ]}
      />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Users className="h-6 w-6" aria-hidden="true" />
          {t('layout', 'customers')}
        </h1>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            placeholder="Search by email..."
            className="pl-9"
            value={emailFilter}
            onChange={(e) => {
              setEmailFilter(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select
          value={b2bFilter}
          onChange={(e) => {
            setB2bFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All types</option>
          <option value="true">B2B</option>
          <option value="false">B2C</option>
        </Select>
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Email</th>
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">Type</th>
              <th className="px-4 py-3 text-left font-medium">VAT</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
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
                  No customers found.
                </td>
              </tr>
            ) : (
              data?.data.map((customer) => (
                <tr
                  key={customer.id}
                  className={`hover:bg-muted/50 ${customer.anonymizedAt ? 'opacity-50' : ''}`}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{customer.email}</div>
                    {customer.anonymizedAt && (
                      <Badge variant="destructive" className="mt-1">
                        Anonymized
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">{customer.name ?? '—'}</td>
                  <td className="px-4 py-3">
                    <Badge variant={customer.isB2b ? 'primary' : 'secondary'}>
                      {customer.isB2b ? 'B2B' : 'B2C'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {customer.vatNumber ? (
                      <span
                        className={`text-sm ${customer.vatValidated ? 'text-success' : 'text-warning'}`}
                      >
                        {customer.vatNumber} {customer.vatValidated ? '✓' : '?'}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/customers/${customer.id}`)}
                        aria-label="View"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {/* UX-only: erase is owner/admin only; server enforces */}
                      {!customer.anonymizedAt && canWrite && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEraseId(customer.id)}
                          aria-label="Erase"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
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
            {data?.total} customers
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

      <Dialog
        open={!!eraseId}
        onClose={() => {
          setEraseId(null);
          setError(null); // clear error so it doesn't linger on next open
        }}
        title="RGPD erase customer"
        description="This is irreversible. Enter the customer's current email to confirm."
      >
        <div className="space-y-4 mt-2">
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="space-y-2">
            <Label required>Confirm email</Label>
            <Input
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              placeholder="customer@example.com"
            />
          </div>
          <div className="flex items-center justify-end gap-3">
            <Button variant="secondary" onClick={() => setEraseId(null)}>
              {t('common', 'cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => eraseMutation.mutate()}
              isLoading={eraseMutation.isPending}
            >
              Erase permanently
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
