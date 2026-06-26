/**
 * Admin Modules management UI over the existing /admin/v1/modules endpoints.
 *
 * Mirrors themes.tsx (and slots.tsx): list installed modules (GET /admin/v1/modules) with
 * enable/disable/uninstall actions, and install via a verified `.tgz` upload
 * (POST /admin/v1/modules/install — a permissionless grant is valid; the install dialog
 * uploads the tarball only, like the theme install dialog).
 *
 * RBAC: the page reads on `modules:read`; the write actions (install/enable/disable/uninstall)
 * gate on `modules:write` (mirrors the API's MODULES_* perms — admin-only, staff fail-closed).
 * The server enforces the real authorization + audit; the client gate is UX-only.
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
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Boxes, Trash2 } from 'lucide-react';

/** Multipart upload cap — mirrors the API ingest's 8 MiB compressed-byte ceiling (defence in depth). */
const MAX_MODULE_BYTES = 8 * 1024 * 1024;

interface InstalledModule {
  id: string;
  name: string;
  version: string;
  grantedPermissions: string[];
  slots: unknown;
  enabled: boolean;
  installedAt: string;
}

export default function ModulesPage() {
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const canWrite = can(role, 'modules:write');

  const modulesQ = useQuery<InstalledModule[]>({
    queryKey: ['modules'],
    queryFn: () => apiFetch('/admin/v1/modules'),
  });

  const [installOpen, setInstallOpen] = React.useState(false);
  const [del, setDel] = React.useState<InstalledModule | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['modules'] });
  const onErr = (e: unknown) =>
    setErr(e instanceof ApiError ? e.message : t('common', 'genericError'));

  const enable = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/admin/v1/modules/${encodeURIComponent(name)}/enable`, { method: 'POST' }),
    onSuccess: () => {
      setErr(null);
      invalidate();
    },
    onError: onErr,
  });
  const disable = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/admin/v1/modules/${encodeURIComponent(name)}/disable`, { method: 'POST' }),
    onSuccess: () => {
      setErr(null);
      invalidate();
    },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: (name: string) =>
      apiFetch(`/admin/v1/modules/${encodeURIComponent(name)}`, { method: 'DELETE' }),
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
      // No grantedPermissions field → a permissionless install (the service grants nothing).
      return apiFetch('/admin/v1/modules/install', { method: 'POST', body: fd });
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

  const modules = modulesQ.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'modules') },
        ]}
      />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Boxes className="h-6 w-6" aria-hidden="true" />
            {t('modules', 'title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t('modules', 'subtitle')}</p>
        </div>
        {canWrite && (
          <Button size="sm" onClick={() => setInstallOpen(true)}>
            {t('modules', 'install')}
          </Button>
        )}
      </div>

      {err && <Alert variant="destructive">{err}</Alert>}

      {modulesQ.isLoading && <p className="text-muted-foreground">{t('common', 'loading')}</p>}

      {modulesQ.isError && !modulesQ.isLoading && (
        <Alert variant="destructive">{t('common', 'genericError')}</Alert>
      )}

      {!modulesQ.isLoading && !modulesQ.isError && modules.length === 0 && (
        <Card className="p-6 text-center text-muted-foreground">{t('modules', 'empty')}</Card>
      )}

      {!modulesQ.isLoading && !modulesQ.isError && modules.length > 0 && (
        <Card className="p-4">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-medium py-1">{t('modules', 'colName')}</th>
                <th className="text-left font-medium py-1">{t('modules', 'colVersion')}</th>
                <th className="text-left font-medium py-1">{t('modules', 'colStatus')}</th>
                {canWrite && (
                  <th className="text-right font-medium py-1">{t('modules', 'colActions')}</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {modules.map((mod) => (
                <tr key={mod.id}>
                  <td className="py-2 font-medium">{mod.name}</td>
                  <td className="py-2 text-muted-foreground">{mod.version}</td>
                  <td className="py-2">
                    {mod.enabled ? (
                      <Badge variant="success">{t('modules', 'enabled')}</Badge>
                    ) : (
                      <Badge variant="secondary">{t('modules', 'disabled')}</Badge>
                    )}
                  </td>
                  {canWrite && (
                    <td className="py-2 text-right whitespace-nowrap">
                      {mod.enabled ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={disable.isPending}
                          onClick={() => disable.mutate(mod.name)}
                        >
                          {t('modules', 'disable')}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={enable.isPending}
                          onClick={() => enable.mutate(mod.name)}
                        >
                          {t('modules', 'enable')}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDel(mod)}
                        aria-label={t('modules', 'deleteTitle')}
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

      <Dialog
        open={!!del}
        onClose={() => setDel(null)}
        title={t('modules', 'deleteTitle')}
        description={t('modules', 'deleteConfirm')}
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
            {t('modules', 'uninstall')}
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
      title={t('modules', 'installTitle')}
      description={t('modules', 'installDescription')}
    >
      <form
        className="space-y-3 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!file) {
            setLocalErr(t('modules', 'fileRequired'));
            return;
          }
          if (file.size > MAX_MODULE_BYTES) {
            // Cheap client-side pre-check — instant feedback, saves a round-trip. Server still enforces.
            setLocalErr(t('modules', 'tooLarge'));
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
          <Label htmlFor="module-file">{t('modules', 'fileLabel')}</Label>
          <input
            id="module-file"
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
            {t('modules', 'install')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
