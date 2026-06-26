import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { ChevronLeft, Snowflake, AlertTriangle } from 'lucide-react';
import { orderStatusVariant } from './orders';

interface Order {
  id: string;
  orderNumber: string;
  email: string;
  status: string;
  currency: string;
  subtotalAmount: number;
  discountAmount: number;
  shippingAmount: number;
  taxAmount: number;
  totalAmount: number;
  refundedAmount: number;
  fulfillmentFrozen: boolean;
  shippingAddress: AddressLike | null;
  billingAddress: AddressLike | null;
  createdAt: string;
}
interface AddressLike {
  name?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  postalCode?: string | null;
  region?: string | null;
  country?: string | null;
}
interface OrderItem {
  id: string;
  productTitle: string;
  sku: string;
  quantity: number;
  unitPriceAmount: number;
  lineTotalAmount: number;
  refundedQuantity: number;
}
interface HistoryRow {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
  createdAt: string;
}
interface OrderDetail {
  order: Order;
  items: OrderItem[];
  history: HistoryRow[];
}
interface Dispute {
  id: string;
  status: string;
  reason: string | null;
  amount: number;
  currency: string;
  providerStatus: string | null;
  evidenceDueBy: string | null;
}

/** The transitions we surface as buttons per current status (server enforces validity). */
function actionsFor(status: string): { to: string; label: string; destructive?: boolean }[] {
  switch (status) {
    case 'pending_payment':
      return [{ to: 'cancelled', label: 'Cancel order', destructive: true }];
    case 'paid':
      return [
        { to: 'fulfilled', label: 'Mark fulfilled' },
        { to: 'cancelled', label: 'Cancel order', destructive: true },
      ];
    case 'fulfilled':
      return [{ to: 'shipped', label: 'Mark shipped' }];
    case 'shipped':
      return [{ to: 'delivered', label: 'Mark delivered' }];
    default:
      return [];
  }
}

function addressLines(a: AddressLike | null): string[] {
  if (!a) return [];
  return [
    a.name,
    a.line1,
    a.line2,
    [a.postalCode, a.city].filter(Boolean).join(' '),
    a.region,
    a.country,
  ]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter((v) => v.length > 0);
}

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canWrite = can(role, 'orders:write');

  const [confirmTo, setConfirmTo] = React.useState<string | null>(null);
  const [refundOpen, setRefundOpen] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const { data, isLoading, error } = useQuery<OrderDetail>({
    queryKey: ['order', id],
    queryFn: () => apiFetch(`/admin/v1/orders/${id}`),
    enabled: !!id,
  });
  const { data: disputeData } = useQuery<{ data: Dispute[] }>({
    queryKey: ['order-disputes', id],
    queryFn: () => apiFetch(`/admin/v1/disputes?orderId=${id}`),
    enabled: !!id,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['order', id] });
    void queryClient.invalidateQueries({ queryKey: ['order-disputes', id] });
  };

  const transition = useMutation({
    mutationFn: (to: string) =>
      apiFetch(`/admin/v1/orders/${id}/transitions`, {
        method: 'POST',
        body: JSON.stringify({ to }),
      }),
    onSuccess: () => {
      setConfirmTo(null);
      setActionError(null);
      invalidate();
    },
    onError: (e: unknown) =>
      setActionError(e instanceof ApiError ? e.message : t('common', 'genericError')),
  });

  const unfreeze = useMutation({
    mutationFn: (disputeId: string) =>
      apiFetch(`/admin/v1/disputes/${disputeId}/unfreeze-fulfillment`, { method: 'POST' }),
    onSuccess: invalidate,
    onError: (e: unknown) =>
      setActionError(e instanceof ApiError ? e.message : t('common', 'genericError')),
  });

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">{t('common', 'loading')}</div>;
  }
  if (error || !data) {
    return (
      <div className="p-6">
        <Alert variant="destructive">{t('common', 'genericError')}</Alert>
      </div>
    );
  }

  const { order, items, history } = data;
  const disputes = disputeData?.data ?? [];
  const openDispute = disputes.find((d) => d.status === 'open') ?? disputes[0];

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'orders'), to: '/orders' },
          { label: order.orderNumber },
        ]}
      />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/orders')}
            aria-label={t('common', 'back')}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {order.orderNumber}
          <Badge variant={orderStatusVariant[order.status] ?? 'default'} className="capitalize">
            {order.status.replace(/_/g, ' ')}
          </Badge>
          {order.fulfillmentFrozen && (
            <Badge variant="secondary" className="gap-1">
              <Snowflake className="h-3 w-3" /> Frozen
            </Badge>
          )}
        </h1>
        {canWrite && (
          <div className="flex items-center gap-2">
            {actionsFor(order.status).map((a) => (
              <Button
                key={a.to}
                variant={a.destructive ? 'destructive' : 'primary'}
                size="sm"
                onClick={() => setConfirmTo(a.to)}
              >
                {a.label}
              </Button>
            ))}
            {order.refundedAmount < order.totalAmount && order.status !== 'pending_payment' && (
              <Button variant="outline" size="sm" onClick={() => setRefundOpen(true)}>
                Refund
              </Button>
            )}
          </div>
        )}
      </div>

      {actionError && <Alert variant="destructive">{actionError}</Alert>}

      {disputes.length > 0 && (
        <Card className="p-4 border-amber-300 bg-amber-50 dark:bg-amber-950/20">
          <h2 className="font-semibold flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" /> Dispute
          </h2>
          {disputes.map((d) => (
            <div key={d.id} className="text-sm flex items-center justify-between gap-4 py-1">
              <span>
                <Badge variant="warning" className="capitalize mr-2">
                  {d.status}
                </Badge>
                {formatMoney(d.amount, d.currency)}
                {d.reason ? ` — ${d.reason}` : ''}
                {d.evidenceDueBy && (
                  <span className="text-muted-foreground">
                    {' '}
                    · evidence due {new Date(d.evidenceDueBy).toLocaleDateString()}
                  </span>
                )}
              </span>
            </div>
          ))}
          {order.fulfillmentFrozen && canWrite && openDispute && (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={unfreeze.isPending}
              onClick={() => unfreeze.mutate(openDispute.id)}
            >
              Unfreeze fulfillment
            </Button>
          )}
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="p-4 md:col-span-2">
          <h2 className="font-semibold mb-3">Line items</h2>
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-medium py-1">Item</th>
                <th className="text-right font-medium py-1">Qty</th>
                <th className="text-right font-medium py-1">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((it) => (
                <tr key={it.id}>
                  <td className="py-2">
                    {it.productTitle}
                    <span className="text-xs text-muted-foreground"> ({it.sku})</span>
                    {it.refundedQuantity > 0 && (
                      <span className="text-xs text-amber-600">
                        {' '}
                        · {it.refundedQuantity} refunded
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right">{it.quantity}</td>
                  <td className="py-2 text-right">
                    {formatMoney(it.lineTotalAmount, order.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="mt-4 space-y-1 text-sm border-t border-border pt-3">
            <Row label="Subtotal" value={formatMoney(order.subtotalAmount, order.currency)} />
            {order.discountAmount > 0 && (
              <Row
                label="Discount"
                value={`-${formatMoney(order.discountAmount, order.currency)}`}
              />
            )}
            <Row label="Shipping" value={formatMoney(order.shippingAmount, order.currency)} />
            <Row label="Tax" value={formatMoney(order.taxAmount, order.currency)} />
            <Row label="Total" value={formatMoney(order.totalAmount, order.currency)} strong />
            {order.refundedAmount > 0 && (
              <Row
                label="Refunded"
                value={`-${formatMoney(order.refundedAmount, order.currency)}`}
              />
            )}
          </dl>
        </Card>

        <div className="space-y-6">
          <Card className="p-4">
            <h2 className="font-semibold mb-2">Customer</h2>
            <p className="text-sm">{order.email}</p>
            {addressLines(order.shippingAddress).length > 0 && (
              <>
                <h3 className="text-xs font-medium text-muted-foreground mt-3 mb-1">Ship to</h3>
                <p className="text-sm leading-5">
                  {addressLines(order.shippingAddress).map((l, i) => (
                    <span key={i}>
                      {l}
                      <br />
                    </span>
                  ))}
                </p>
              </>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="font-semibold mb-2">Timeline</h2>
            <ol className="space-y-2 text-sm">
              {history.map((h) => (
                <li key={h.id} className="flex items-start gap-2">
                  <span className="text-muted-foreground whitespace-nowrap">
                    {new Date(h.createdAt).toLocaleString()}
                  </span>
                  <span className="capitalize">
                    {h.fromStatus ? `${h.fromStatus.replace(/_/g, ' ')} → ` : ''}
                    {h.toStatus.replace(/_/g, ' ')}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>

      <Dialog
        open={!!confirmTo}
        onClose={() => setConfirmTo(null)}
        title={`Confirm: ${confirmTo?.replace(/_/g, ' ')}`}
        description="This changes the order status. Continue?"
      >
        <div className="flex items-center justify-end gap-3 mt-4">
          <Button variant="secondary" onClick={() => setConfirmTo(null)}>
            {t('common', 'cancel')}
          </Button>
          <Button
            variant={confirmTo === 'cancelled' ? 'destructive' : 'primary'}
            disabled={transition.isPending}
            onClick={() => confirmTo && transition.mutate(confirmTo)}
          >
            {t('common', 'confirm')}
          </Button>
        </div>
      </Dialog>

      {refundOpen && (
        <RefundModal
          orderId={order.id}
          items={items}
          onClose={() => setRefundOpen(false)}
          onDone={() => {
            setRefundOpen(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'font-semibold' : 'text-muted-foreground'}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RefundModal({
  orderId,
  items,
  onClose,
  onDone,
}: {
  orderId: string;
  items: OrderItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = React.useState<'full' | 'items'>('full');
  const [restock, setRestock] = React.useState(true);
  const [reason, setReason] = React.useState('');
  const [qty, setQty] = React.useState<Record<string, number>>({});
  const [err, setErr] = React.useState<string | null>(null);
  // Stable idempotency key per modal-open → a retry never double-refunds.
  const idemRef = React.useRef(crypto.randomUUID());

  const refund = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { restock, idempotencyKey: idemRef.current };
      if (reason.trim()) body.reason = reason.trim();
      if (mode === 'items') {
        const lines = items
          .map((it) => ({ orderItemId: it.id, quantity: qty[it.id] ?? 0, restock }))
          .filter((l) => l.quantity > 0);
        if (lines.length === 0) throw new ApiError('Select at least one item to refund', 400, null);
        body.items = lines;
      }
      return apiFetch(`/admin/v1/orders/${orderId}/refunds`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    onSuccess: onDone,
    onError: (e: unknown) => setErr(e instanceof ApiError ? e.message : 'Refund failed'),
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title="Issue refund"
      description="Issues a credit note for the refunded amount."
    >
      <div className="space-y-4 mt-2">
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'full'} onChange={() => setMode('full')} /> Full
            remaining
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'items'} onChange={() => setMode('items')} />{' '}
            Selected items
          </label>
        </div>

        {mode === 'items' && (
          <div className="space-y-2">
            {items.map((it) => {
              const remaining = it.quantity - it.refundedQuantity;
              return (
                <div key={it.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex-1">
                    {it.productTitle}{' '}
                    <span className="text-muted-foreground">({remaining} left)</span>
                  </span>
                  <Input
                    type="number"
                    min={0}
                    max={remaining}
                    className="w-20"
                    aria-label={`Refund quantity for ${it.productTitle}`}
                    value={qty[it.id] ?? 0}
                    onChange={(e) =>
                      setQty((q) => ({
                        ...q,
                        [it.id]: Math.max(0, Math.min(remaining, Number(e.target.value) || 0)),
                      }))
                    }
                  />
                </div>
              );
            })}
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
          Restock refunded items
        </label>

        <div>
          <Label htmlFor="refund-reason">Reason (optional)</Label>
          <Input
            id="refund-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. customer request"
          />
        </div>

        {err && <Alert variant="destructive">{err}</Alert>}

        <p className="text-xs text-muted-foreground">
          Refunds are processed via the payment provider and a credit note is issued. This cannot be
          undone.
        </p>

        <div className="flex items-center justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            {t('common', 'cancel')}
          </Button>
          <Button variant="destructive" disabled={refund.isPending} onClick={() => refund.mutate()}>
            Issue refund
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
