import React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Tags, Plus, Pencil, Trash2 } from 'lucide-react';

interface Tag {
  id: string;
  name: string;
  slug: string;
}

export default function TagsPage() {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Tag | null>(null);
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery<Tag[]>({
    queryKey: ['tags'],
    queryFn: () => apiFetch('/admin/v1/tags'),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = { name, slug: slug || undefined };
      if (editing) {
        await apiFetch(`/admin/v1/tags/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/admin/v1/tags', { method: 'POST', body: JSON.stringify(payload) });
      }
    },
    onSuccess: () => {
      setDialogOpen(false);
      setEditing(null);
      setName('');
      setSlug('');
      refetch();
    },
    onError: () => setError(t('common', 'genericError')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/v1/tags/${id}`, { method: 'DELETE' }),
    onSuccess: () => refetch(),
  });

  function openCreate() {
    setEditing(null);
    setName('');
    setSlug('');
    setDialogOpen(true);
  }

  function openEdit(tag: Tag) {
    setEditing(tag);
    setName(tag.name);
    setSlug(tag.slug);
    setDialogOpen(true);
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'tags') },
        ]}
      />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Tags className="h-6 w-6" aria-hidden="true" />
          {t('layout', 'tags')}
        </h1>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" /> New tag
        </Button>
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}

      {isLoading ? (
        <p className="text-muted-foreground">{t('common', 'loading')}</p>
      ) : data?.length === 0 ? (
        <p className="text-muted-foreground">No tags yet.</p>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Name</th>
                <th className="px-4 py-3 text-left font-medium">Slug</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data?.map((tag) => (
                <tr key={tag.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3 font-medium">{tag.name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{tag.slug}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(tag)}
                        aria-label="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteMutation.mutate(tag.id)}
                        aria-label="Delete"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editing ? 'Edit tag' : 'New tag'}
      >
        <div className="space-y-4">
          {error && <Alert variant="destructive">{error}</Alert>}
          <div className="space-y-2">
            <Label required>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Slug</Label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="auto-generated"
            />
          </div>
          <div className="flex items-center justify-end gap-3">
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              {t('common', 'cancel')}
            </Button>
            <Button onClick={() => saveMutation.mutate()} isLoading={saveMutation.isPending}>
              {editing ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
