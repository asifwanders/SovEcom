/**
 * 3.9g — Admin Themes management UI over the existing /admin/v1/themes endpoints.
 *
 * Scope note: GET /admin/v1/themes reads the `installed_themes` table, which is EMPTY on a fresh
 * install — the bundled `default`/`boutique` themes are NOT seeded into it. Surfacing/switching the
 * bundled themes would require a core migration + seed change, which is OUT OF SCOPE here and a
 * pending human decision. This page manages whatever the endpoint returns (installed themes) and
 * shows a clean empty-state otherwise, with a note that bundled themes are not yet listed.
 */
import React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Palette, Pencil, Trash2 } from 'lucide-react';

/** Multipart upload cap — mirrors the API ingest's 8 MiB compressed-byte ceiling (defence in depth). */
const MAX_THEME_BYTES = 8 * 1024 * 1024;

interface InstalledTheme {
  id: string;
  name: string;
  version: string;
  slots: unknown;
  settings: Record<string, unknown>;
  isActive: boolean;
  installedAt: string;
}

export default function ThemesPage() {
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canWrite = can(role, 'themes:write');

  const themesQ = useQuery<InstalledTheme[]>({
    queryKey: ['themes'],
    queryFn: () => apiFetch('/admin/v1/themes'),
  });

  const [installOpen, setInstallOpen] = React.useState(false);
  const [settingsFor, setSettingsFor] = React.useState<InstalledTheme | null>(null);
  const [del, setDel] = React.useState<InstalledTheme | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['themes'] });
  const onErr = (e: unknown) =>
    setErr(e instanceof ApiError ? e.message : t('common', 'genericError'));

  const activate = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/admin/v1/themes/${encodeURIComponent(name)}/activate`, { method: 'POST' }),
    onSuccess: () => {
      setErr(null);
      invalidate();
    },
    onError: onErr,
  });
  const saveSettings = useMutation({
    mutationFn: (v: { name: string; settings: Record<string, unknown> }) =>
      apiFetch(`/admin/v1/themes/${encodeURIComponent(v.name)}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ settings: v.settings }),
      }),
    onSuccess: () => {
      setSettingsFor(null);
      setErr(null);
      invalidate();
    },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/admin/v1/themes/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDel(null);
      setErr(null);
      invalidate();
    },
    onError: onErr,
  });
  const install = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      // apiFetch detects FormData and omits Content-Type so the browser sets multipart + boundary.
      return apiFetch('/admin/v1/themes/install', { method: 'POST', body: fd });
    },
    onSuccess: () => {
      setInstallOpen(false);
      setErr(null);
      invalidate();
    },
    // Install errors are surfaced INSIDE the install dialog (via the `error` prop below), since the
    // modal overlay would otherwise hide the page-level Alert. The dialog stays open so the user can
    // read the failure (8 MiB cap / 422 verification) and retry.
  });

  const themes = themesQ.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'themes') },
        ]}
      />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Palette className="h-6 w-6" aria-hidden="true" />
          {t('themes', 'title')}
        </h1>
        {canWrite && (
          <Button size="sm" onClick={() => setInstallOpen(true)}>
            {t('themes', 'install')}
          </Button>
        )}
      </div>

      <p className="text-sm text-muted-foreground">{t('themes', 'bundledNote')}</p>

      {err && <Alert variant="destructive">{err}</Alert>}

      {themesQ.isLoading && <p className="text-muted-foreground">{t('common', 'loading')}</p>}

      {themesQ.isError && !themesQ.isLoading && (
        <Alert variant="destructive">{t('common', 'genericError')}</Alert>
      )}

      {!themesQ.isLoading && !themesQ.isError && themes.length === 0 && (
        <Card className="p-6 text-center text-muted-foreground">{t('themes', 'empty')}</Card>
      )}

      {!themesQ.isLoading && !themesQ.isError && themes.length > 0 && (
        <Card className="p-4">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-medium py-1">{t('themes', 'colName')}</th>
                <th className="text-left font-medium py-1">{t('themes', 'colVersion')}</th>
                <th className="text-left font-medium py-1">{t('themes', 'colStatus')}</th>
                {canWrite && (
                  <th className="text-right font-medium py-1">{t('themes', 'colActions')}</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {themes.map((th) => (
                <tr key={th.id}>
                  <td className="py-2 font-medium">{th.name}</td>
                  <td className="py-2 text-muted-foreground">{th.version}</td>
                  <td className="py-2">
                    {th.isActive && <Badge variant="success">{t('themes', 'active')}</Badge>}
                  </td>
                  {canWrite && (
                    <td className="py-2 text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={th.isActive || activate.isPending}
                        onClick={() => activate.mutate(th.name)}
                      >
                        {t('themes', 'activate')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSettingsFor(th)}
                        aria-label={t('themes', 'editSettings')}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDel(th)}
                        aria-label={t('themes', 'deleteTitle')}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {installOpen && (
        <InstallForm
          pending={install.isPending}
          error={
            install.isError
              ? install.error instanceof ApiError
                ? install.error.message
                : t('common', 'genericError')
              : null
          }
          onCancel={() => {
            install.reset();
            setInstallOpen(false);
          }}
          onSubmit={(file) => install.mutate(file)}
        />
      )}

      {settingsFor && (
        <SettingsForm
          theme={settingsFor}
          pending={saveSettings.isPending}
          onCancel={() => setSettingsFor(null)}
          onSubmit={(settings) => saveSettings.mutate({ name: settingsFor.name, settings })}
        />
      )}

      <Dialog
        open={!!del}
        onClose={() => setDel(null)}
        title={t('themes', 'deleteTitle')}
        description={t('themes', 'deleteConfirm')}
      >
        <div className="flex items-center justify-end gap-3 mt-4">
          <Button variant="secondary" onClick={() => setDel(null)}>
            {t('common', 'cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => del && remove.mutate(del.name)}
          >
            {t('common', 'delete')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function InstallForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (file: File) => void;
}) {
  const [file, setFile] = React.useState<File | null>(null);
  const [localErr, setLocalErr] = React.useState<string | null>(null);

  return (
    <Dialog
      open
      onClose={onCancel}
      title={t('themes', 'installTitle')}
      description={t('themes', 'installDescription')}
    >
      <form
        className="space-y-3 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!file) {
            setLocalErr(t('themes', 'fileRequired'));
            return;
          }
          if (file.size > MAX_THEME_BYTES) {
            // Cheap client-side pre-check — instant feedback, saves a round-trip. Server still enforces.
            setLocalErr(t('themes', 'tooLarge'));
            return;
          }
          setLocalErr(null);
          onSubmit(file);
        }}
      >
        {/* localErr = client-side validation; error = server-side install failure (8 MiB / 422). */}
        {localErr && <Alert variant="destructive">{localErr}</Alert>}
        {!localErr && error && <Alert variant="destructive">{error}</Alert>}
        <div>
          <Label htmlFor="theme-file">{t('themes', 'fileLabel')}</Label>
          <input
            id="theme-file"
            type="file"
            accept=".tgz,.tar.gz,application/gzip,application/x-gzip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:border-input file:bg-transparent file:px-3 file:py-1.5 file:text-sm"
          />
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('common', 'cancel')}
          </Button>
          <Button type="submit" disabled={!file || pending}>
            {t('themes', 'install')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function SettingsForm({
  theme,
  pending,
  onCancel,
  onSubmit,
}: {
  theme: { name: string; settings: Record<string, unknown> };
  pending: boolean;
  onCancel: () => void;
  onSubmit: (settings: Record<string, unknown>) => void;
}) {
  const [text, setText] = React.useState(() => JSON.stringify(theme.settings ?? {}, null, 2));
  const [jsonErr, setJsonErr] = React.useState<string | null>(null);

  function submit() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setJsonErr(t('themes', 'invalidJson'));
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setJsonErr(t('themes', 'invalidJson'));
      return;
    }
    setJsonErr(null);
    onSubmit(parsed as Record<string, unknown>);
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title={`${t('themes', 'settingsTitle')} — ${theme.name}`}
      description={t('themes', 'settingsDescription')}
    >
      <form
        className="space-y-3 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {jsonErr && <Alert variant="destructive">{jsonErr}</Alert>}
        <div>
          <Label htmlFor="theme-settings">{t('themes', 'settingsLabel')}</Label>
          <Textarea
            id="theme-settings"
            rows={12}
            className="font-mono text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('common', 'cancel')}
          </Button>
          <Button type="submit" disabled={pending}>
            {t('common', 'save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
