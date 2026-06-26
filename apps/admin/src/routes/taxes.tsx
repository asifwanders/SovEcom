import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
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
import { Percent, Pencil, Trash2 } from 'lucide-react';

interface TaxSettings {
  taxMode: 'none' | 'eu_vat';
  pricesIncludeTax: boolean;
  ossPosture: 'below_threshold' | 'above_or_opted_in';
  originCountry?: string | null;
  vatNumber?: string | null;
  euVatRegistration?: { originCountry?: string | null; vatNumber?: string | null } | null;
}
interface TaxRate {
  id: string;
  country: string;
  region: string | null;
  rate: string; // NUMERIC(5,4) as string, e.g. "0.2000"
  name: string;
}

const originOf = (s?: TaxSettings) => s?.euVatRegistration?.originCountry ?? s?.originCountry ?? '';
const vatOf = (s?: TaxSettings) => s?.euVatRegistration?.vatNumber ?? s?.vatNumber ?? '';

export default function TaxesPage() {
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canWrite = can(role, 'settings:write');

  const settingsQ = useQuery<TaxSettings>({
    queryKey: ['tax-settings'],
    queryFn: () => apiFetch('/admin/v1/taxes/settings'),
  });
  const ratesQ = useQuery<TaxRate[]>({
    queryKey: ['tax-rates'],
    queryFn: () => apiFetch('/admin/v1/taxes/rates'),
  });

  const [rateForm, setRateForm] = React.useState<TaxRate | 'new' | null>(null);
  const [delId, setDelId] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const onErr = (e: unknown) =>
    setErr(e instanceof ApiError ? e.message : t('common', 'genericError'));

  const saveSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/admin/v1/taxes/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      setErr(null);
      void queryClient.invalidateQueries({ queryKey: ['tax-settings'] });
    },
    onError: onErr,
  });
  const saveRate = useMutation({
    mutationFn: (v: { id?: string; body: Record<string, unknown> }) =>
      apiFetch(v.id ? `/admin/v1/taxes/rates/${v.id}` : '/admin/v1/taxes/rates', {
        method: v.id ? 'PUT' : 'POST',
        body: JSON.stringify(v.body),
      }),
    onSuccess: () => {
      setRateForm(null);
      setErr(null);
      void queryClient.invalidateQueries({ queryKey: ['tax-rates'] });
    },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/v1/taxes/rates/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDelId(null);
      void queryClient.invalidateQueries({ queryKey: ['tax-rates'] });
    },
    onError: onErr,
  });

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'taxes') },
        ]}
      />
      <h1 className="text-2xl font-semibold flex items-center gap-2">
        <Percent className="h-6 w-6" aria-hidden="true" />
        {t('layout', 'taxes')}
      </h1>
      {err && <Alert variant="destructive">{err}</Alert>}

      {settingsQ.data && (
        <SettingsCard
          settings={settingsQ.data}
          canWrite={canWrite}
          pending={saveSettings.isPending}
          onSave={(b) => saveSettings.mutate(b)}
        />
      )}

      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Tax rates</h2>
          {canWrite && (
            <Button size="sm" onClick={() => setRateForm('new')}>
              {t('common', 'create')}
            </Button>
          )}
        </div>
        <table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="text-left font-medium py-1">Country</th>
              <th className="text-left font-medium py-1">Region</th>
              <th className="text-left font-medium py-1">Name</th>
              <th className="text-right font-medium py-1">Rate</th>
              {canWrite && <th className="text-right font-medium py-1">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {ratesQ.data?.map((r) => (
              <tr key={r.id}>
                <td className="py-2 font-medium">{r.country}</td>
                <td className="py-2 text-muted-foreground">{r.region ?? '—'}</td>
                <td className="py-2">{r.name}</td>
                <td className="py-2 text-right">{(Number(r.rate) * 100).toFixed(2)}%</td>
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
                      onClick={() => setDelId(r.id)}
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
                  No tax rates yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {rateForm && (
        <RateForm
          initial={rateForm}
          pending={saveRate.isPending}
          onCancel={() => setRateForm(null)}
          onSubmit={(body) =>
            saveRate.mutate({ id: rateForm !== 'new' ? rateForm.id : undefined, body })
          }
        />
      )}

      <Dialog
        open={!!delId}
        onClose={() => setDelId(null)}
        title="Delete tax rate"
        description="Cannot be undone."
      >
        <div className="flex items-center justify-end gap-3 mt-4">
          <Button variant="secondary" onClick={() => setDelId(null)}>
            {t('common', 'cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => delId && remove.mutate(delId)}
          >
            {t('common', 'delete')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function SettingsCard({
  settings,
  canWrite,
  pending,
  onSave,
}: {
  settings: TaxSettings;
  canWrite: boolean;
  pending: boolean;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [taxMode, setTaxMode] = React.useState(settings.taxMode);
  const [pricesIncludeTax, setPricesIncludeTax] = React.useState(settings.pricesIncludeTax);
  const [ossPosture, setOssPosture] = React.useState(settings.ossPosture);
  const [originCountry, setOriginCountry] = React.useState(originOf(settings));
  const [vatNumber, setVatNumber] = React.useState(vatOf(settings));

  return (
    <Card className="p-4">
      <h2 className="font-semibold mb-3">Settings</h2>
      <form
        className="space-y-3 max-w-md"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            taxMode,
            pricesIncludeTax,
            ossPosture,
            euVatRegistration: {
              originCountry: originCountry.trim() ? originCountry.trim().toUpperCase() : null,
              vatNumber: vatNumber.trim() || null,
            },
          });
        }}
      >
        <div>
          <Label htmlFor="t-mode">Tax mode</Label>
          <Select
            id="t-mode"
            disabled={!canWrite}
            value={taxMode}
            onChange={(e) => setTaxMode(e.target.value as TaxSettings['taxMode'])}
          >
            <option value="none">None</option>
            <option value="eu_vat">EU VAT</option>
          </Select>
        </div>
        <div>
          <Label htmlFor="t-oss">OSS posture</Label>
          <Select
            id="t-oss"
            disabled={!canWrite}
            value={ossPosture}
            onChange={(e) => setOssPosture(e.target.value as TaxSettings['ossPosture'])}
          >
            <option value="below_threshold">Below threshold (origin VAT)</option>
            <option value="above_or_opted_in">Above threshold / opted in (destination VAT)</option>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="t-origin">Origin country</Label>
            <Input
              id="t-origin"
              disabled={!canWrite}
              value={originCountry}
              onChange={(e) => setOriginCountry(e.target.value)}
              maxLength={2}
            />
          </div>
          <div>
            <Label htmlFor="t-vat">VAT number</Label>
            <Input
              id="t-vat"
              disabled={!canWrite}
              value={vatNumber}
              onChange={(e) => setVatNumber(e.target.value)}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            disabled={!canWrite}
            checked={pricesIncludeTax}
            onChange={(e) => setPricesIncludeTax(e.target.checked)}
          />
          Prices include tax
        </label>
        {canWrite && (
          <Button type="submit" disabled={pending}>
            {t('common', 'save')}
          </Button>
        )}
      </form>
    </Card>
  );
}

function RateForm({
  initial,
  pending,
  onCancel,
  onSubmit,
}: {
  initial: TaxRate | 'new';
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const isEdit = initial !== 'new';
  const [country, setCountry] = React.useState(isEdit ? initial.country : '');
  const [region, setRegion] = React.useState(isEdit ? (initial.region ?? '') : '');
  const [rate, setRate] = React.useState(isEdit ? initial.rate : '');
  const [name, setName] = React.useState(isEdit ? initial.name : '');
  const valid =
    /^[A-Za-z]{2}$/.test(country.trim()) &&
    /^0(\.\d{1,4})?$/.test(rate.trim()) &&
    name.trim() !== '';

  return (
    <Dialog
      open
      onClose={onCancel}
      title={isEdit ? 'Edit tax rate' : 'New tax rate'}
      description='Rate is a fraction, e.g. "0.2000" for 20%.'
    >
      <form
        className="space-y-3 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid)
            onSubmit({
              country: country.trim().toUpperCase(),
              region: region.trim() || null,
              rate: rate.trim(),
              name: name.trim(),
            });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="tr-country">Country (ISO-2)</Label>
            <Input
              id="tr-country"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              maxLength={2}
              required
            />
          </div>
          <div>
            <Label htmlFor="tr-region">Region (optional)</Label>
            <Input id="tr-region" value={region} onChange={(e) => setRegion(e.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="tr-name">Name</Label>
          <Input id="tr-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="tr-rate">Rate (fraction)</Label>
          <Input
            id="tr-rate"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="0.2000"
            required
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
