/**
 * Admin Content Pages list.
 *
 * Lists `/admin/v1/pages` via react-query, with
 * locale + status filters (mirrors the products list filter idiom), a "New page"
 * button, and per-row edit/delete affordances. Delete is confirm → DELETE →
 * invalidate. Uses the reactive `useT()` so labels re-render on a locale switch.
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useT } from '@/lib/i18n-context';
import { useAuthStore } from '@/lib/auth';
import { can } from '@/lib/permissions';
import { queryClient } from '@/lib/query-client';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { FileText, Pencil, Trash2 } from 'lucide-react';

interface PageRow {
  id: string;
  slug: string;
  title: string;
  locale: 'fr' | 'en';
  status: 'draft' | 'published';
  updatedAt: string;
}

const statusVariant: Record<string, BadgeProps['variant']> = {
  draft: 'secondary',
  published: 'success',
};

export default function PagesPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const role = useAuthStore((s) => s.user?.role ?? null);
  // UX-only gate; the server enforces real authz (PAGES_DELETE = owner/admin).
  const canDelete = can(role, 'pages:delete');
  const [localeFilter, setLocaleFilter] = React.useState<string>('');
  const [statusFilter, setStatusFilter] = React.useState<string>('');
  const [deleteId, setDeleteId] = React.useState<string | null>(null);

  const { data, isLoading, error } = useQuery<PageRow[]>({
    queryKey: ['pages', localeFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (localeFilter) params.set('locale', localeFilter);
      if (statusFilter) params.set('status', statusFilter);
      const qs = params.toString();
      return apiFetch(`/admin/v1/pages${qs ? `?${qs}` : ''}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/v1/pages/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteId(null);
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
  });

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'pages') },
        ]}
      />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FileText className="h-6 w-6" aria-hidden="true" />
          {t('pages', 'title')}
        </h1>
        <Button onClick={() => navigate('/pages/new')}>{t('pages', 'newPage')}</Button>
      </div>

      <div className="flex items-center gap-3">
        <Select
          aria-label={t('pages', 'fieldLocale')}
          value={localeFilter}
          onChange={(e) => setLocaleFilter(e.target.value)}
        >
          <option value="">{t('pages', 'allLocales')}</option>
          <option value="en">{t('pages', 'localeEn')}</option>
          <option value="fr">{t('pages', 'localeFr')}</option>
        </Select>
        <Select
          aria-label={t('pages', 'fieldStatus')}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">{t('pages', 'allStatuses')}</option>
          <option value="draft">{t('pages', 'statusDraft')}</option>
          <option value="published">{t('pages', 'statusPublished')}</option>
        </Select>
      </div>

      {error && <Alert variant="destructive">{t('common', 'genericError')}</Alert>}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium">{t('pages', 'colTitle')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('pages', 'colSlug')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('pages', 'colLocale')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('pages', 'colStatus')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('pages', 'colUpdated')}</th>
              <th className="px-4 py-3 text-right font-medium">{t('pages', 'colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {t('common', 'loading')}
                </td>
              </tr>
            ) : (data?.length ?? 0) === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {t('pages', 'empty')}
                </td>
              </tr>
            ) : (
              data?.map((page) => (
                <tr key={page.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3 font-medium">{page.title}</td>
                  <td className="px-4 py-3 text-muted-foreground">/{page.slug}</td>
                  <td className="px-4 py-3 uppercase">{page.locale}</td>
                  <td className="px-4 py-3">
                    <Badge variant={statusVariant[page.status] ?? 'default'}>
                      {page.status === 'published'
                        ? t('pages', 'statusPublished')
                        : t('pages', 'statusDraft')}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {new Date(page.updatedAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/pages/${page.id}`)}
                        aria-label={t('common', 'edit')}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteId(page.id)}
                          aria-label={t('common', 'delete')}
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

      <Dialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        title={t('pages', 'deleteTitle')}
        description={t('pages', 'deleteConfirm')}
      >
        <div className="flex items-center justify-end gap-3 mt-4">
          <Button variant="secondary" onClick={() => setDeleteId(null)}>
            {t('common', 'cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => deleteId && deleteMutation.mutate(deleteId)}
            isLoading={deleteMutation.isPending}
          >
            {t('common', 'delete')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
