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
import { FolderTree, Plus, Pencil, Trash2, ChevronRight, ChevronDown } from 'lucide-react';

interface Category {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  position: number;
  description: string | null;
}

function buildTree(categories: Category[]): CategoryNode[] {
  const map = new Map<string, CategoryNode>();
  const roots: CategoryNode[] = [];
  for (const cat of categories) {
    map.set(cat.id, { ...cat, children: [] });
  }
  for (const cat of categories) {
    const node = map.get(cat.id)!;
    if (cat.parentId && map.has(cat.parentId)) {
      map.get(cat.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots.sort((a, b) => a.position - b.position);
}

interface CategoryNode extends Category {
  children: CategoryNode[];
}

function TreeNode({
  node,
  depth,
  onEdit,
  onDelete,
  expanded,
  toggle,
}: {
  node: CategoryNode;
  depth: number;
  onEdit: (cat: Category) => void;
  onDelete: (id: string) => void;
  expanded: Set<string>;
  toggle: (id: string) => void;
}) {
  const isExpanded = expanded.has(node.id);
  return (
    <div>
      <div
        className="flex items-center gap-2 py-2 px-3 hover:bg-muted rounded-md"
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            onClick={() => toggle(node.id)}
            className="p-1 rounded-sm hover:bg-muted-foreground/20"
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        ) : (
          <span className="w-6" />
        )}
        <span className="flex-1 font-medium">{node.name}</span>
        <span className="text-xs text-muted-foreground">/{node.slug}</span>
        <Button variant="ghost" size="sm" onClick={() => onEdit(node)} aria-label="Edit">
          <Pencil className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onDelete(node.id)} aria-label="Delete">
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>
      {isExpanded &&
        node.children.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            depth={depth + 1}
            onEdit={onEdit}
            onDelete={onDelete}
            expanded={expanded}
            toggle={toggle}
          />
        ))}
    </div>
  );
}

export default function CategoriesPage() {
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Category | null>(null);
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [parentId, setParentId] = React.useState<string>('');
  const [error, setError] = React.useState<string | null>(null);

  const { data, isLoading, refetch } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => apiFetch('/admin/v1/categories'),
  });

  const tree = React.useMemo(() => buildTree(data ?? []), [data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = { name, slug: slug || undefined, parentId: parentId || null };
      if (editing) {
        await apiFetch(`/admin/v1/categories/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/admin/v1/categories', { method: 'POST', body: JSON.stringify(payload) });
      }
    },
    onSuccess: () => {
      setDialogOpen(false);
      setEditing(null);
      setName('');
      setSlug('');
      setParentId('');
      refetch();
    },
    onError: () => setError(t('common', 'genericError')),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiFetch(`/admin/v1/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => refetch(),
  });

  function openCreate() {
    setEditing(null);
    setName('');
    setSlug('');
    setParentId('');
    setDialogOpen(true);
  }

  function openEdit(cat: Category) {
    setEditing(cat);
    setName(cat.name);
    setSlug(cat.slug);
    setParentId(cat.parentId ?? '');
    setDialogOpen(true);
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'categories') },
        ]}
      />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FolderTree className="h-6 w-6" aria-hidden="true" />
          {t('layout', 'categories')}
        </h1>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-2" /> New category
        </Button>
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}

      {isLoading ? (
        <p className="text-muted-foreground">{t('common', 'loading')}</p>
      ) : tree.length === 0 ? (
        <p className="text-muted-foreground">No categories yet.</p>
      ) : (
        <div className="rounded-lg border border-border p-2">
          {tree.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              depth={0}
              onEdit={openEdit}
              onDelete={(id) => deleteMutation.mutate(id)}
              expanded={expanded}
              toggle={toggle}
            />
          ))}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        title={editing ? 'Edit category' : 'New category'}
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
          <div className="space-y-2">
            <Label>Parent</Label>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            >
              <option value="">None (root)</option>
              {data
                ?.filter((c) => c.id !== editing?.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
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
