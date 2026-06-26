import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { BarChart3 } from 'lucide-react';

/**
 * Admin Analytics settings. Edits the three storefront analytics ids over
 * GET/PUT /admin/v1/analytics. Plausible is privacy-friendly (no warning). GA4 + Meta carry a
 * prominent RGPD warning and require acknowledging it before a save that sets them (legal protection,
 * "not optional UX"). settings:write gates the form.
 */
interface AnalyticsSettings {
  plausibleDomain: string | null;
  ga4Id: string | null;
  metaPixelId: string | null;
}

export default function AnalyticsPage() {
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canWrite = can(role, 'settings:write');

  const q = useQuery<AnalyticsSettings>({
    queryKey: ['analytics-settings'],
    queryFn: () => apiFetch('/admin/v1/analytics'),
  });

  const [plausible, setPlausible] = React.useState('');
  const [ga4, setGa4] = React.useState('');
  const [meta, setMeta] = React.useState('');
  const [ackGa, setAckGa] = React.useState(false);
  const [ackMeta, setAckMeta] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  // Hydrate the form once the settings load.
  React.useEffect(() => {
    if (!q.data) return;
    setPlausible(q.data.plausibleDomain ?? '');
    setGa4(q.data.ga4Id ?? '');
    setMeta(q.data.metaPixelId ?? '');
  }, [q.data]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/admin/v1/analytics', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      setErr(null);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ['analytics-settings'] });
    },
    onError: (e: unknown) =>
      setErr(e instanceof ApiError ? e.message : t('common', 'genericError')),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    // RGPD gate: acknowledging is required whenever a GA4 / Meta id is being set.
    if ((ga4.trim() && !ackGa) || (meta.trim() && !ackMeta)) {
      setErr(t('analytics', 'ackRequired'));
      return;
    }
    setErr(null);
    save.mutate({
      plausibleDomain: plausible.trim() || null,
      ga4Id: ga4.trim() || null,
      metaPixelId: meta.trim() || null,
      // Server requires this when enabling GA4/Meta; the checks above guarantee it's acknowledged.
      rgpdAcknowledged: Boolean(ga4.trim() || meta.trim()),
    });
  };

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs items={[{ label: t('analytics', 'title') }]} />
      <div className="flex items-center gap-3">
        <BarChart3 className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-semibold">{t('analytics', 'title')}</h1>
          <p className="text-sm text-muted-foreground">{t('analytics', 'subtitle')}</p>
        </div>
      </div>

      {q.isLoading && <p className="text-sm text-muted-foreground">{t('common', 'loading')}</p>}

      {q.data && (
        <form onSubmit={onSubmit} className="max-w-2xl space-y-6">
          {/* Plausible — privacy-friendly, no warning */}
          <Card className="p-5 space-y-2">
            <Label htmlFor="plausible">{t('analytics', 'plausibleLabel')}</Label>
            <Input
              id="plausible"
              value={plausible}
              onChange={(e) => setPlausible(e.target.value)}
              placeholder="shop.example.com"
              disabled={!canWrite}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">{t('analytics', 'plausibleHint')}</p>
          </Card>

          {/* Google Analytics — RGPD warning + acknowledge */}
          <Card className="p-5 space-y-3">
            <Label htmlFor="ga4">{t('analytics', 'ga4Label')}</Label>
            <Input
              id="ga4"
              value={ga4}
              onChange={(e) => {
                setGa4(e.target.value);
                if (!e.target.value.trim()) setAckGa(false);
              }}
              placeholder="G-XXXXXXXXXX"
              disabled={!canWrite}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">{t('analytics', 'ga4Hint')}</p>
            {ga4.trim() && (
              <>
                <Alert variant="warning">{t('analytics', 'rgpdGa')}</Alert>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ackGa}
                    onChange={(e) => {
                      setAckGa(e.target.checked);
                      if (e.target.checked) setErr(null); // ticking clears the "acknowledge" error
                    }}
                    disabled={!canWrite}
                  />
                  {t('analytics', 'ackGa')}
                </label>
              </>
            )}
          </Card>

          {/* Meta Pixel — RGPD warning + acknowledge */}
          <Card className="p-5 space-y-3">
            <Label htmlFor="meta">{t('analytics', 'metaLabel')}</Label>
            <Input
              id="meta"
              value={meta}
              onChange={(e) => {
                setMeta(e.target.value);
                if (!e.target.value.trim()) setAckMeta(false);
              }}
              placeholder="1234567890"
              disabled={!canWrite}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">{t('analytics', 'metaHint')}</p>
            {meta.trim() && (
              <>
                <Alert variant="warning">{t('analytics', 'rgpdMeta')}</Alert>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ackMeta}
                    onChange={(e) => {
                      setAckMeta(e.target.checked);
                      if (e.target.checked) setErr(null); // ticking clears the "acknowledge" error
                    }}
                    disabled={!canWrite}
                  />
                  {t('analytics', 'ackMeta')}
                </label>
              </>
            )}
          </Card>

          {err && <Alert variant="destructive">{err}</Alert>}
          {saved && <Alert variant="success">{t('analytics', 'saved')}</Alert>}

          {canWrite && (
            <Button type="submit" disabled={save.isPending}>
              {t('common', 'save')}
            </Button>
          )}
        </form>
      )}
    </div>
  );
}
