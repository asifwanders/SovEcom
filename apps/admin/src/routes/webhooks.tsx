import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Webhook, Trash2, RefreshCw, Copy } from 'lucide-react';

const WEBHOOK_EVENTS = [
  'order.created',
  'order.paid',
  'order.shipped',
  'order.cancelled',
  'order.refunded',
  'order.partially_refunded',
  'refund.issued',
  'product.created',
  'product.updated',
  'product.deleted',
] as const;

interface Subscription {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}
interface CreatedSubscription extends Subscription {
  secret: string;
}
interface Delivery {
  id: string;
  subscriptionId: string;
  event: string;
  status: 'pending' | 'delivered' | 'failed' | 'exhausted';
  attempts: number;
  responseCode: number | null;
  lastError: string | null;
  createdAt: string;
}
interface DeliveriesResponse {
  data: Delivery[];
  total: number;
  page: number;
  pageSize: number;
}

const deliveryVariant: Record<string, BadgeProps['variant']> = {
  pending: 'secondary',
  delivered: 'success',
  failed: 'warning',
  exhausted: 'destructive',
};

export default function WebhooksPage() {
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canWrite = can(role, 'settings:write');

  const [createOpen, setCreateOpen] = React.useState(false);
  const [secret, setSecret] = React.useState<CreatedSubscription | null>(null);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [statusFilter, setStatusFilter] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [err, setErr] = React.useState<string | null>(null);
  const onErr = (e: unknown) =>
    setErr(e instanceof ApiError ? e.message : t('common', 'genericError'));

  const subsQ = useQuery<Subscription[]>({
    queryKey: ['webhook-subscriptions'],
    queryFn: () => apiFetch('/admin/v1/webhooks/subscriptions'),
  });
  const deliveriesQ = useQuery<DeliveriesResponse>({
    queryKey: ['webhook-deliveries', page, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (statusFilter) params.set('status', statusFilter);
      return apiFetch(`/admin/v1/webhooks/deliveries?${params.toString()}`);
    },
  });

  const create = useMutation({
    mutationFn: (body: { url: string; events: string[] }) =>
      apiFetch<CreatedSubscription>('/admin/v1/webhooks/subscriptions', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (sub) => {
      setCreateOpen(false);
      setErr(null);
      setSecret(sub); // show the signing secret ONCE
      void queryClient.invalidateQueries({ queryKey: ['webhook-subscriptions'] });
    },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/admin/v1/webhooks/subscriptions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteId(null);
      void queryClient.invalidateQueries({ queryKey: ['webhook-subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] });
    },
    onError: onErr,
  });
  const retry = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/admin/v1/webhooks/deliveries/${id}/retry`, { method: 'POST' }),
    onSuccess: () => {
      setErr(null);
      void queryClient.invalidateQueries({ queryKey: ['webhook-deliveries'] });
    },
    onError: onErr,
  });

  const totalPages = deliveriesQ.data
    ? Math.ceil(deliveriesQ.data.total / deliveriesQ.data.pageSize)
    : 0;
  const subUrl = (id: string) => subsQ.data?.find((s) => s.id === id)?.url ?? id;

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'webhooks') },
        ]}
      />
      <h1 className="text-2xl font-semibold flex items-center gap-2">
        <Webhook className="h-6 w-6" aria-hidden="true" />
        {t('layout', 'webhooks')}
      </h1>
      {err && <Alert variant="destructive">{err}</Alert>}

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Subscriptions</h2>
          {canWrite && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              {t('common', 'create')}
            </Button>
          )}
        </div>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-medium py-1">URL</th>
              <th className="text-left font-medium py-1">Events</th>
              <th className="text-left font-medium py-1">Status</th>
              {canWrite && <th className="text-right font-medium py-1">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {subsQ.data?.map((s) => (
              <tr key={s.id}>
                <td className="py-2 font-mono text-xs break-all max-w-[20rem]">{s.url}</td>
                <td className="py-2 text-muted-foreground">{s.events.length} event(s)</td>
                <td className="py-2">
                  <Badge variant={s.active ? 'success' : 'secondary'}>
                    {s.active ? 'Active' : 'Inactive'}
                  </Badge>
                </td>
                {canWrite && (
                  <td className="py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteId(s.id)}
                      aria-label="Delete subscription"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {subsQ.data?.length === 0 && (
              <tr>
                <td colSpan={4} className="py-4 text-center text-muted-foreground">
                  No subscriptions yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Delivery log</h2>
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
            <option value="exhausted">Exhausted</option>
          </Select>
        </div>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-medium py-1">Event</th>
              <th className="text-left font-medium py-1">Subscription</th>
              <th className="text-left font-medium py-1">Status</th>
              <th className="text-right font-medium py-1">Attempts</th>
              <th className="text-right font-medium py-1">Code</th>
              {canWrite && <th className="text-right font-medium py-1">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {deliveriesQ.data?.data.map((d) => (
              <tr key={d.id}>
                <td className="py-2 font-medium">{d.event}</td>
                <td className="py-2 font-mono text-xs break-all max-w-[16rem]">
                  {subUrl(d.subscriptionId)}
                </td>
                <td className="py-2">
                  <Badge variant={deliveryVariant[d.status] ?? 'default'} className="capitalize">
                    {d.status}
                  </Badge>
                </td>
                <td className="py-2 text-right">{d.attempts}</td>
                <td className="py-2 text-right text-muted-foreground">{d.responseCode ?? '—'}</td>
                {canWrite && (
                  <td className="py-2 text-right">
                    {(d.status === 'failed' || d.status === 'exhausted') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(d.id)}
                        aria-label="Retry delivery"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {deliveriesQ.data?.data.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-muted-foreground">
                  No deliveries yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {totalPages > 1 && (
          <div className="flex items-center justify-end gap-2 mt-3">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Prev
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
              Next
            </Button>
          </div>
        )}
      </Card>

      {createOpen && (
        <CreateForm
          pending={create.isPending}
          onCancel={() => setCreateOpen(false)}
          onSubmit={(b) => create.mutate(b)}
        />
      )}

      {/* The signing secret is shown EXACTLY ONCE — the API never returns it again. */}
      <Dialog
        open={!!secret}
        onClose={() => setSecret(null)}
        title="Subscription created"
        description="Copy the signing secret now — it will not be shown again."
      >
        <div className="space-y-3 mt-2">
          <Label htmlFor="wh-secret">Signing secret</Label>
          <div className="flex items-center gap-2">
            <Input
              id="wh-secret"
              readOnly
              value={secret?.secret ?? ''}
              className="font-mono text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => secret && void navigator.clipboard?.writeText(secret.secret)}
              aria-label="Copy secret"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setSecret(null)}>Done</Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title="Delete subscription"
        description="This stops deliveries and removes the subscription + its delivery log. Cannot be undone."
      >
        <div className="flex items-center justify-end gap-3 mt-4">
          <Button variant="secondary" onClick={() => setDeleteId(null)}>
            {t('common', 'cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => deleteId && remove.mutate(deleteId)}
          >
            {t('common', 'delete')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function CreateForm({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: { url: string; events: string[] }) => void;
}) {
  const [url, setUrl] = React.useState('');
  const [events, setEvents] = React.useState<string[]>([]);
  const valid = /^https?:\/\/.+/.test(url.trim()) && events.length > 0;
  const toggle = (e: string) =>
    setEvents((p) => (p.includes(e) ? p.filter((x) => x !== e) : [...p, e]));

  return (
    <Dialog
      open
      onClose={onCancel}
      title="New subscription"
      description="Events POST to your HTTPS endpoint, HMAC-signed."
    >
      <form
        className="space-y-3 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit({ url: url.trim(), events });
        }}
      >
        <div>
          <Label htmlFor="wh-url">Endpoint URL (https)</Label>
          <Input
            id="wh-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/hooks"
            required
          />
        </div>
        <fieldset>
          <legend className="text-sm font-medium mb-1">Events</legend>
          <div className="grid grid-cols-2 gap-1 text-sm">
            {WEBHOOK_EVENTS.map((e) => (
              <label key={e} className="flex items-center gap-2">
                <input type="checkbox" checked={events.includes(e)} onChange={() => toggle(e)} />{' '}
                {e}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('common', 'cancel')}
          </Button>
          <Button type="submit" disabled={!valid || pending}>
            {t('common', 'create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
