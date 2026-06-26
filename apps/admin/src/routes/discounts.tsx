import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Ticket, Pencil, Trash2 } from 'lucide-react';

interface Discount {
  id: string;
  name: string;
  code: string | null;
  type: 'percentage' | 'fixed';
  value: number;
  currency: string | null;
  appliesTo: 'all' | 'products' | 'categories';
  targetIds: string[] | null;
  minCartAmount: number | null;
  stackable: boolean;
  active: boolean;
}

interface FormState {
  name: string;
  code: string;
  type: 'percentage' | 'fixed';
  value: string;
  currency: string;
  appliesTo: 'all' | 'products' | 'categories';
  targetIds: string;
  minCartAmount: string;
  stackable: boolean;
  active: boolean;
}

const EMPTY: FormState = {
  name: '',
  code: '',
  type: 'percentage',
  value: '',
  currency: 'EUR',
  appliesTo: 'all',
  targetIds: '',
  minCartAmount: '',
  stackable: false,
  active: true,
};

function toForm(d: Discount): FormState {
  return {
    name: d.name,
    code: d.code ?? '',
    type: d.type,
    value: String(d.value),
    currency: d.currency ?? 'EUR',
    appliesTo: d.appliesTo,
    targetIds: (d.targetIds ?? []).join('\n'),
    minCartAmount: d.minCartAmount != null ? String(d.minCartAmount) : '',
    stackable: d.stackable,
    active: d.active,
  };
}

export default function DiscountsPage() {
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canWrite = can(role, 'settings:write');

  const [editing, setEditing] = React.useState<Discount | 'new' | null>(null);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [formErr, setFormErr] = React.useState<string | null>(null);

  const { data, isLoading, error } = useQuery<Discount[]>({
    queryKey: ['discounts'],
    queryFn: () => apiFetch('/admin/v1/discounts'),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['discounts'] });

  const save = useMutation({
    mutationFn: (vars: { id?: string; body: Record<string, unknown> }) =>
      apiFetch(vars.id ? `/admin/v1/discounts/${vars.id}` : '/admin/v1/discounts', {
        method: vars.id ? 'PATCH' : 'POST',
        body: JSON.stringify(vars.body),
      }),
    onSuccess: () => {
      setEditing(null);
      setFormErr(null);
      void invalidate();
    },
    onError: (e: unknown) =>
      setFormErr(e instanceof ApiError ? e.message : t('common', 'genericError')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/v1/discounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteId(null);
      void invalidate();
    },
  });

  function submit(form: FormState) {
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      type: form.type,
      value: Number(form.value),
      appliesTo: form.appliesTo,
      stackable: form.stackable,
      active: form.active,
    };
    if (form.type === 'fixed') body.currency = form.currency.trim().toUpperCase();
    if (form.minCartAmount.trim()) body.minCartAmount = Number(form.minCartAmount);
    if (form.appliesTo !== 'all') {
      body.targetIds = form.targetIds
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      // Scope is the whole cart → clear any previously-set targets (avoids stale ids on edit).
      body.targetIds = null;
    }
    const id = editing && editing !== 'new' ? editing.id : undefined;
    save.mutate({ id, body });
  }

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'discounts') },
        ]}
      />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Ticket className="h-6 w-6" aria-hidden="true" />
          {t('layout', 'discounts')}
        </h1>
        {canWrite && <Button onClick={() => setEditing('new')}>{t('common', 'create')}</Button>}
      </div>

      {error && <Alert variant="destructive">{t('common', 'genericError')}</Alert>}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">Code</th>
              <th className="px-4 py-3 text-left font-medium">Type</th>
              <th className="px-4 py-3 text-right font-medium">Value</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              {canWrite && <th className="px-4 py-3 text-right font-medium">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {t('common', 'loading')}
                </td>
              </tr>
            ) : data?.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No discounts yet.
                </td>
              </tr>
            ) : (
              data?.map((d) => (
                <tr key={d.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3 font-medium">{d.name}</td>
                  <td className="px-4 py-3">
                    {d.code ? (
                      <code className="text-xs">{d.code}</code>
                    ) : (
                      <span className="text-muted-foreground">auto</span>
                    )}
                  </td>
                  <td className="px-4 py-3 capitalize">{d.type}</td>
                  <td className="px-4 py-3 text-right">
                    {d.type === 'percentage'
                      ? `${(d.value / 100).toFixed(2)}%`
                      : formatMoney(d.value, d.currency ?? 'EUR')}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={d.active ? 'success' : 'secondary'}>
                      {d.active ? 'Active' : 'Inactive'}
                    </Badge>
                  </td>
                  {canWrite && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(d)}
                          aria-label="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteId(d.id)}
                          aria-label="Delete"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <DiscountForm
          initial={editing === 'new' ? EMPTY : toForm(editing)}
          isEdit={editing !== 'new'}
          pending={save.isPending}
          error={formErr}
          onCancel={() => {
            setEditing(null);
            setFormErr(null);
          }}
          onSubmit={submit}
        />
      )}

      <Dialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title="Delete discount"
        description="This permanently removes the discount. This action cannot be undone."
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

function DiscountForm({
  initial,
  isEdit,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  initial: FormState;
  isEdit: boolean;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (f: FormState) => void;
}) {
  const [f, setF] = React.useState<FormState>(initial);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));
  // Percentage is points ×100, so 100% = 10000 — cap client-side to match the server refine.
  const value = Number(f.value);
  const valid =
    f.name.trim() !== '' &&
    f.value.trim() !== '' &&
    value >= 0 &&
    (f.type !== 'percentage' || value <= 10000);

  return (
    <Dialog
      open
      onClose={onCancel}
      title={isEdit ? 'Edit discount' : 'New discount'}
      description="Percentage value is points ×100 (10% = 1000); fixed value is in minor units."
    >
      <form
        className="space-y-3 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(f);
        }}
      >
        <div>
          <Label htmlFor="d-name">Name</Label>
          <Input
            id="d-name"
            value={f.name}
            onChange={(e) => set('name', e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="d-code">Code (blank = automatic)</Label>
          <Input id="d-code" value={f.code} onChange={(e) => set('code', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="d-type">Type</Label>
            <Select
              id="d-type"
              value={f.type}
              onChange={(e) => set('type', e.target.value as FormState['type'])}
            >
              <option value="percentage">Percentage</option>
              <option value="fixed">Fixed</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="d-value">Value</Label>
            <Input
              id="d-value"
              type="number"
              min={0}
              value={f.value}
              onChange={(e) => set('value', e.target.value)}
              required
            />
          </div>
        </div>
        {f.type === 'fixed' && (
          <div>
            <Label htmlFor="d-currency">Currency</Label>
            <Input
              id="d-currency"
              value={f.currency}
              onChange={(e) => set('currency', e.target.value)}
              maxLength={3}
            />
          </div>
        )}
        <div>
          <Label htmlFor="d-applies">Applies to</Label>
          <Select
            id="d-applies"
            value={f.appliesTo}
            onChange={(e) => set('appliesTo', e.target.value as FormState['appliesTo'])}
          >
            <option value="all">Entire cart</option>
            <option value="products">Specific products</option>
            <option value="categories">Specific categories</option>
          </Select>
        </div>
        {f.appliesTo !== 'all' && (
          <div>
            <Label htmlFor="d-targets">
              {f.appliesTo === 'products' ? 'Product' : 'Category'} IDs (one per line)
            </Label>
            <textarea
              id="d-targets"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              rows={3}
              value={f.targetIds}
              onChange={(e) => set('targetIds', e.target.value)}
            />
          </div>
        )}
        <div>
          <Label htmlFor="d-mincart">Minimum cart (minor units, optional)</Label>
          <Input
            id="d-mincart"
            type="number"
            min={0}
            value={f.minCartAmount}
            onChange={(e) => set('minCartAmount', e.target.value)}
          />
        </div>
        <div className="flex items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={f.stackable}
              onChange={(e) => set('stackable', e.target.checked)}
            />{' '}
            Stackable
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={f.active}
              onChange={(e) => set('active', e.target.checked)}
            />{' '}
            Active
          </label>
        </div>

        {error && <Alert variant="destructive">{error}</Alert>}

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('common', 'cancel')}
          </Button>
          <Button type="submit" disabled={!valid || pending}>
            {t('common', 'save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
