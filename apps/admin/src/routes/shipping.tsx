import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Truck, Pencil, Trash2 } from 'lucide-react';

interface Zone {
  id: string;
  name: string;
  countries: string[];
}
type RateType = 'flat' | 'free_over' | 'weight_based';
interface Rate {
  id: string;
  zoneId: string;
  name: string;
  type: RateType;
  amount: number;
  currency: string;
  freeOverAmount: number | null;
  weightMinGrams: number | null;
  weightMaxGrams: number | null;
}

export default function ShippingPage() {
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canWrite = can(role, 'settings:write');

  const zonesQ = useQuery<Zone[]>({
    queryKey: ['shipping-zones'],
    queryFn: () => apiFetch('/admin/v1/shipping/zones'),
  });
  const ratesQ = useQuery<Rate[]>({
    queryKey: ['shipping-rates'],
    queryFn: () => apiFetch('/admin/v1/shipping/rates'),
  });

  const [zoneForm, setZoneForm] = React.useState<Zone | 'new' | null>(null);
  const [rateForm, setRateForm] = React.useState<Rate | 'new' | null>(null);
  const [del, setDel] = React.useState<{ kind: 'zone' | 'rate'; id: string } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['shipping-zones'] });
    void queryClient.invalidateQueries({ queryKey: ['shipping-rates'] });
  };
  const onErr = (e: unknown) =>
    setErr(e instanceof ApiError ? e.message : t('common', 'genericError'));

  const saveZone = useMutation({
    mutationFn: (v: { id?: string; body: Record<string, unknown> }) =>
      apiFetch(v.id ? `/admin/v1/shipping/zones/${v.id}` : '/admin/v1/shipping/zones', {
        method: v.id ? 'PUT' : 'POST',
        body: JSON.stringify(v.body),
      }),
    onSuccess: () => {
      setZoneForm(null);
      setErr(null);
      invalidate();
    },
    onError: onErr,
  });
  const saveRate = useMutation({
    mutationFn: (v: { id?: string; body: Record<string, unknown> }) =>
      apiFetch(v.id ? `/admin/v1/shipping/rates/${v.id}` : '/admin/v1/shipping/rates', {
        method: v.id ? 'PUT' : 'POST',
        body: JSON.stringify(v.body),
      }),
    onSuccess: () => {
      setRateForm(null);
      setErr(null);
      invalidate();
    },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: (d: { kind: 'zone' | 'rate'; id: string }) =>
      apiFetch(`/admin/v1/shipping/${d.kind === 'zone' ? 'zones' : 'rates'}/${d.id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setDel(null);
      invalidate();
    },
    onError: onErr,
  });

  const zoneName = (id: string) => zonesQ.data?.find((z) => z.id === id)?.name ?? id;

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'shipping') },
        ]}
      />
      <h1 className="text-2xl font-semibold flex items-center gap-2">
        <Truck className="h-6 w-6" aria-hidden="true" />
        {t('layout', 'shipping')}
      </h1>
      {err && <Alert variant="destructive">{err}</Alert>}

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Zones</h2>
          {canWrite && (
            <Button size="sm" onClick={() => setZoneForm('new')}>
              {t('common', 'create')}
            </Button>
          )}
        </div>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-medium py-1">Name</th>
              <th className="text-left font-medium py-1">Countries</th>
              {canWrite && <th className="text-right font-medium py-1">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {zonesQ.data?.map((z) => (
              <tr key={z.id}>
                <td className="py-2 font-medium">{z.name}</td>
                <td className="py-2 text-muted-foreground">{z.countries.join(', ')}</td>
                {canWrite && (
                  <td className="py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setZoneForm(z)}
                      aria-label="Edit zone"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDel({ kind: 'zone', id: z.id })}
                      aria-label="Delete zone"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {zonesQ.data?.length === 0 && (
              <tr>
                <td colSpan={3} className="py-4 text-center text-muted-foreground">
                  No zones yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Rates</h2>
          {canWrite && zonesQ.data && zonesQ.data.length > 0 && (
            <Button size="sm" onClick={() => setRateForm('new')}>
              {t('common', 'create')}
            </Button>
          )}
        </div>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-medium py-1">Name</th>
              <th className="text-left font-medium py-1">Zone</th>
              <th className="text-left font-medium py-1">Type</th>
              <th className="text-right font-medium py-1">Amount</th>
              {canWrite && <th className="text-right font-medium py-1">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {ratesQ.data?.map((r) => (
              <tr key={r.id}>
                <td className="py-2 font-medium">{r.name}</td>
                <td className="py-2 text-muted-foreground">{zoneName(r.zoneId)}</td>
                <td className="py-2">{r.type.replace(/_/g, ' ')}</td>
                <td className="py-2 text-right">{formatMoney(r.amount, r.currency)}</td>
                {canWrite && (
                  <td className="py-2 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRateForm(r)}
                      aria-label="Edit rate"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDel({ kind: 'rate', id: r.id })}
                      aria-label="Delete rate"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {ratesQ.data?.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-muted-foreground">
                  No rates yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {zoneForm && (
        <ZoneForm
          initial={
            zoneForm === 'new'
              ? { name: '', countries: '' }
              : { name: zoneForm.name, countries: zoneForm.countries.join(', ') }
          }
          isEdit={zoneForm !== 'new'}
          pending={saveZone.isPending}
          onCancel={() => setZoneForm(null)}
          onSubmit={(name, countries) =>
            saveZone.mutate({
              id: zoneForm !== 'new' ? zoneForm.id : undefined,
              body: { name, countries },
            })
          }
        />
      )}
      {rateForm && zonesQ.data && (
        <RateForm
          zones={zonesQ.data}
          initial={rateForm}
          pending={saveRate.isPending}
          onCancel={() => setRateForm(null)}
          onSubmit={(body) =>
            saveRate.mutate({ id: rateForm !== 'new' ? rateForm.id : undefined, body })
          }
        />
      )}

      <Dialog
        open={!!del}
        onClose={() => setDel(null)}
        title={`Delete ${del?.kind}`}
        description="This permanently removes it. Cannot be undone."
      >
        <div className="flex items-center justify-end gap-3 mt-4">
          <Button variant="secondary" onClick={() => setDel(null)}>
            {t('common', 'cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => del && remove.mutate(del)}
          >
            {t('common', 'delete')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function ZoneForm({
  initial,
  isEdit,
  pending,
  onCancel,
  onSubmit,
}: {
  initial: { name: string; countries: string };
  isEdit: boolean;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (name: string, countries: string[]) => void;
}) {
  const [name, setName] = React.useState(initial.name);
  const [countries, setCountries] = React.useState(initial.countries);
  const list = countries
    .split(/[\s,]+/)
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const valid = name.trim() !== '' && list.length > 0;
  return (
    <Dialog
      open
      onClose={onCancel}
      title={isEdit ? 'Edit zone' : 'New zone'}
      description="Countries are ISO 3166-1 alpha-2 codes."
    >
      <form
        className="space-y-3 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(name.trim(), list);
        }}
      >
        <div>
          <Label htmlFor="z-name">Name</Label>
          <Input id="z-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="z-countries">Countries (e.g. FR, DE, BE)</Label>
          <Input
            id="z-countries"
            value={countries}
            onChange={(e) => setCountries(e.target.value)}
          />
        </div>
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

function RateForm({
  zones,
  initial,
  pending,
  onCancel,
  onSubmit,
}: {
  zones: Zone[];
  initial: Rate | 'new';
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const isEdit = initial !== 'new';
  const [zoneId, setZoneId] = React.useState(isEdit ? initial.zoneId : (zones[0]?.id ?? ''));
  const [name, setName] = React.useState(isEdit ? initial.name : '');
  const [type, setType] = React.useState<RateType>(isEdit ? initial.type : 'flat');
  const [amount, setAmount] = React.useState(isEdit ? String(initial.amount) : '');
  const [currency, setCurrency] = React.useState(isEdit ? initial.currency : 'EUR');
  const [freeOver, setFreeOver] = React.useState(
    isEdit && initial.freeOverAmount != null ? String(initial.freeOverAmount) : '',
  );
  const [wMin, setWMin] = React.useState(
    isEdit && initial.weightMinGrams != null ? String(initial.weightMinGrams) : '',
  );
  const [wMax, setWMax] = React.useState(
    isEdit && initial.weightMaxGrams != null ? String(initial.weightMaxGrams) : '',
  );
  const valid =
    zoneId !== '' &&
    name.trim() !== '' &&
    amount.trim() !== '' &&
    (type !== 'free_over' || freeOver.trim() !== '');

  function submit() {
    const body: Record<string, unknown> = {
      zoneId,
      name: name.trim(),
      type,
      amount: Number(amount),
      currency: currency.trim().toUpperCase(),
    };
    if (type === 'free_over') body.freeOverAmount = Number(freeOver);
    if (type === 'weight_based') {
      if (wMin.trim()) body.weightMinGrams = Number(wMin);
      if (wMax.trim()) body.weightMaxGrams = Number(wMax);
    }
    onSubmit(body);
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title={isEdit ? 'Edit rate' : 'New rate'}
      description="Amounts are in minor units."
    >
      <form
        className="space-y-3 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) submit();
        }}
      >
        <div>
          <Label htmlFor="r-zone">Zone</Label>
          <Select id="r-zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="r-name">Name</Label>
          <Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="r-type">Type</Label>
            <Select id="r-type" value={type} onChange={(e) => setType(e.target.value as RateType)}>
              <option value="flat">Flat</option>
              <option value="free_over">Free over threshold</option>
              <option value="weight_based">Weight based</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="r-amount">Amount (minor units)</Label>
            <Input
              id="r-amount"
              type="number"
              min={0}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>
        </div>
        <div>
          <Label htmlFor="r-currency">Currency</Label>
          <Input
            id="r-currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            maxLength={3}
          />
        </div>
        {type === 'free_over' && (
          <div>
            <Label htmlFor="r-freeover">Free over (minor units)</Label>
            <Input
              id="r-freeover"
              type="number"
              min={0}
              value={freeOver}
              onChange={(e) => setFreeOver(e.target.value)}
              required
            />
          </div>
        )}
        {type === 'weight_based' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="r-wmin">Weight min (g)</Label>
              <Input
                id="r-wmin"
                type="number"
                min={0}
                value={wMin}
                onChange={(e) => setWMin(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="r-wmax">Weight max (g)</Label>
              <Input
                id="r-wmax"
                type="number"
                min={0}
                value={wMax}
                onChange={(e) => setWMax(e.target.value)}
              />
            </div>
          </div>
        )}
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
