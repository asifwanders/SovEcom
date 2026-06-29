import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiFetch, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Alert } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Dialog } from '@/components/ui/dialog';
import { Plus, Trash2, X } from 'lucide-react';

const productSchema = z.object({
  title: z.string().min(1, t('common', 'required')),
  slug: z.string().min(1, t('common', 'required')).optional(),
  description: z.string().optional(),
  status: z.enum(['draft', 'published', 'archived']),
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
});

type ProductFormData = z.infer<typeof productSchema>;

interface Variant {
  id?: string;
  /** Stable React key — set once on load/create, never changes even on reorder. */
  _stableKey?: string;
  sku: string;
  title: string;
  priceAmount: number;
  currency: string;
  stockQuantity: number;
  allowBackorder: boolean;
  position: number;
}

interface Category {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
}

interface Tag {
  id: string;
  name: string;
  slug: string;
}

export default function ProductFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isEdit = !!id;
  const [error, setError] = React.useState<string | null>(null);
  const [variants, setVariants] = React.useState<Variant[]>([]);
  const [assignedCategoryIds, setAssignedCategoryIds] = React.useState<string[]>([]);
  const [assignedTagIds, setAssignedTagIds] = React.useState<string[]>([]);
  // id = join-row id (for React keys); imageId = actual image id (used for detach API call)
  const [images, setImages] = React.useState<{ id: string; imageId: string; url: string }[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const [variantToDelete, setVariantToDelete] = React.useState<number | null>(null);
  // Snapshot of persisted variants as last loaded from the server, keyed by id.
  // Used in edit mode to diff: a persisted variant is PATCHed only when a field
  // actually changed (otherwise the variant sub-resource is left untouched).
  const loadedVariantsRef = React.useRef<Record<string, Variant>>({});

  const {
    data: product,
    isLoading: isProductLoading,
    isError: isProductError,
  } = useQuery({
    queryKey: ['product', id],
    queryFn: () =>
      apiFetch<{
        id: string;
        title: string;
        slug: string;
        description: string | null;
        status: string;
        seoTitle: string | null;
        seoDescription: string | null;
        variants: Variant[];
        // `url` is computed server-side (adminFindById) from the image's thumbnail
        // variant (else the original key); the client no longer touches raw keys.
        images: { id: string; imageId: string; url: string | null }[];
        // The admin GET /products/:id endpoint does NOT include categories/tags
        // (see products.repository.ts findById — it only joins variants+images).
        // They're declared optional here so the reset effect can null-coalesce them.
        categories?: { id: string }[];
        tags?: { id: string }[];
      }>(`/admin/v1/products/${id}`),
    enabled: isEdit,
  });

  const { data: categories } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => apiFetch('/admin/v1/categories'),
  });

  const { data: tags } = useQuery<Tag[]>({
    queryKey: ['tags'],
    queryFn: () => apiFetch('/admin/v1/tags'),
  });

  const form = useForm<ProductFormData>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      title: '',
      slug: '',
      description: '',
      status: 'draft',
      seoTitle: '',
      seoDescription: '',
    },
  });

  // `reset` is referentially stable across renders in react-hook-form, so we
  // depend on it directly rather than the whole `form` object — depending on
  // `form` (a fresh-ish object) risked a reset→render→reset loop. Every array
  // pulled off `product` is null-coalesced because the GET response is not
  // guaranteed to include all of them (categories/tags are absent today).
  const { reset } = form;
  React.useEffect(() => {
    if (!product) return;
    reset({
      title: product.title,
      slug: product.slug,
      description: product.description ?? '',
      status: product.status as 'draft' | 'published' | 'archived',
      seoTitle: product.seoTitle ?? '',
      seoDescription: product.seoDescription ?? '',
    });
    const loaded = (product.variants ?? []).map((v) => ({
      ...v,
      currency: v.currency.toUpperCase(),
      _stableKey: v.id ?? crypto.randomUUID(),
    }));
    setVariants(loaded);
    // Snapshot persisted variants (by id) so the save can diff against them.
    loadedVariantsRef.current = loaded.reduce<Record<string, Variant>>((acc, v) => {
      if (v.id) acc[v.id] = v;
      return acc;
    }, {});
    setAssignedCategoryIds((product.categories ?? []).map((c) => c.id));
    setAssignedTagIds((product.tags ?? []).map((t) => t.id));
    setImages(
      (product.images ?? [])
        .filter((i): i is { id: string; imageId: string; url: string } => typeof i.url === 'string')
        .map((i) => ({ id: i.id, imageId: i.imageId, url: i.url })),
    );
  }, [product, reset]);

  /**
   * Map a form Variant to the create/PATCH body shape the variant DTOs accept.
   * Drops the client-only `_stableKey` and `id` (the sub-resource schemas are
   * .strict()); numeric fields are coerced from the controlled inputs.
   */
  function toVariantBody(v: Variant): Record<string, unknown> {
    return {
      sku: v.sku || undefined,
      title: v.title || undefined,
      priceAmount: Number(v.priceAmount),
      currency: v.currency,
      stockQuantity: Number(v.stockQuantity),
      allowBackorder: v.allowBackorder,
      position: Number(v.position),
    };
  }

  /**
   * Persist variant create/update for EDIT mode by diffing the current `variants`
   * state against the snapshot loaded from the server. New variants (no id) are
   * POSTed; persisted variants whose fields changed are PATCHed (currency is
   * always included alongside priceAmount, per the variant DTO contract). Deletes
   * are handled live in removeVariant, so they need no work here.
   */
  async function syncVariantsForEdit(productId: string): Promise<void> {
    for (const v of variants) {
      if (!v.id) {
        // New variant — create it.
        await apiFetch(`/admin/v1/products/${productId}/variants`, {
          method: 'POST',
          body: JSON.stringify(toVariantBody(v)),
        });
        continue;
      }
      const prev = loadedVariantsRef.current[v.id];
      // No snapshot (shouldn't happen) or an actual field change → PATCH.
      if (
        !prev ||
        prev.sku !== v.sku ||
        prev.title !== v.title ||
        Number(prev.priceAmount) !== Number(v.priceAmount) ||
        prev.currency !== v.currency ||
        Number(prev.stockQuantity) !== Number(v.stockQuantity) ||
        prev.allowBackorder !== v.allowBackorder ||
        Number(prev.position) !== Number(v.position)
      ) {
        await apiFetch(`/admin/v1/products/${productId}/variants/${v.id}`, {
          method: 'PATCH',
          body: JSON.stringify(toVariantBody(v)),
        });
      }
    }
  }

  const saveMutation = useMutation({
    mutationFn: async (data: ProductFormData) => {
      let productId: string;
      if (isEdit) {
        // BUG-1: the product PATCH body must contain ONLY the scalar fields the
        // backend UpdateProductSchema (.strict()) accepts — `variants` is NOT one
        // of them and previously made every save 400. Variants are persisted via
        // their own sub-resource below.
        await apiFetch(`/admin/v1/products/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: data.title,
            slug: data.slug || undefined,
            description: data.description ?? '',
            status: data.status,
            seoTitle: data.seoTitle ?? '',
            seoDescription: data.seoDescription ?? '',
          }),
        });
        productId = id!;
        // Diff variants against the loaded snapshot and persist each change via
        // the variant sub-resource. (Deletes are already wired live in removeVariant.)
        await syncVariantsForEdit(productId);
      } else {
        // CREATE: variants ARE accepted inline by CreateProductSchema, so send them.
        const result = await apiFetch<{ id: string }>('/admin/v1/products', {
          method: 'POST',
          body: JSON.stringify({
            title: data.title,
            slug: data.slug || undefined,
            description: data.description ?? '',
            status: data.status,
            seoTitle: data.seoTitle ?? '',
            seoDescription: data.seoDescription ?? '',
            variants: variants.map(toVariantBody),
          }),
        });
        productId = result.id;
        // S6: attach any images uploaded during create to the newly created product
        for (const img of images) {
          await apiFetch(`/admin/v1/products/${productId}/images`, {
            method: 'POST',
            body: JSON.stringify({ imageId: img.imageId }),
          });
        }
      }
      // S5: await category/tag assignments sequentially; failures propagate to onError
      await apiFetch(`/admin/v1/products/${productId}/categories`, {
        method: 'PUT',
        body: JSON.stringify({ categoryIds: assignedCategoryIds }),
      });
      await apiFetch(`/admin/v1/products/${productId}/tags`, {
        method: 'PUT',
        body: JSON.stringify({ tagIds: assignedTagIds }),
      });
    },
    onSuccess: async () => {
      // Resync the cached product so the form reflects server state (new variant
      // ids, normalized slug) if the user returns to it.
      if (isEdit) await queryClient.invalidateQueries({ queryKey: ['product', id] });
      navigate('/products');
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.status === 422) {
        setError(
          'Cannot publish: a variant has a price of 0 and is not marked as free. Please set a price or enable the free option.',
        );
      } else {
        setError(t('common', 'genericError'));
      }
    },
  });

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      // apiFetch detects FormData and omits Content-Type so the browser sets multipart + boundary.
      // BUG-2a: the upload response field is `originalUrl` (ImageResponseDto), NOT `url` —
      // reading `url` left the preview src undefined (blank thumbnail).
      const result = await apiFetch<{ id: string; originalUrl: string }>('/admin/v1/images', {
        method: 'POST',
        body: formData,
      });
      if (isEdit && id) {
        // On edit: immediately attach to the existing product
        await apiFetch(`/admin/v1/products/${id}/images`, {
          method: 'POST',
          body: JSON.stringify({ imageId: result.id }),
        });
      }
      // On create: images accumulate in state and are attached after the product is saved (S6).
      // id and imageId are the same here (no join row yet); on edit the join row id
      // comes from the product query but we only need imageId for the detach call.
      setImages((prev) => [
        ...prev,
        { id: result.id, imageId: result.id, url: result.originalUrl },
      ]);
    } catch {
      setError('Image upload failed');
    } finally {
      setUploading(false);
    }
  }

  function addVariant() {
    setVariants((prev) => [
      ...prev,
      {
        sku: '',
        title: '',
        priceAmount: 0,
        currency: 'EUR',
        stockQuantity: 0,
        allowBackorder: false,
        position: prev.length,
        _stableKey: crypto.randomUUID(),
      },
    ]);
  }

  function updateVariant(index: number, patch: Partial<Variant>) {
    setVariants((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  }

  async function removeVariant(index: number) {
    const v = variants[index];
    if (!v) return;
    if (v.id && isEdit && id) {
      await apiFetch(`/admin/v1/products/${id}/variants/${v.id}`, { method: 'DELETE' });
    }
    setVariants((prev) => prev.filter((_, i) => i !== index));
    setVariantToDelete(null);
  }

  // In edit mode, gate the form on the product fetch so we never render blank.
  if (isEdit && isProductLoading) {
    return <div className="p-6 text-muted-foreground">{t('common', 'loading')}</div>;
  }
  if (isEdit && (isProductError || !product)) {
    return (
      <div className="p-6">
        <Alert variant="destructive">{t('common', 'genericError')}</Alert>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'products'), to: '/products' },
          { label: isEdit ? 'Edit product' : 'New product' },
        ]}
      />

      <h1 className="text-2xl font-semibold">{isEdit ? 'Edit product' : 'New product'}</h1>

      {error && <Alert variant="destructive">{error}</Alert>}

      <form onSubmit={form.handleSubmit((data) => saveMutation.mutate(data))} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Basic information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title" required>
                Title
              </Label>
              <Input id="title" {...form.register('title')} />
              {form.formState.errors.title && (
                <p className="text-sm text-destructive">{form.formState.errors.title.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="slug">Slug</Label>
              <Input id="slug" {...form.register('slug')} placeholder="auto-generated-from-title" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" {...form.register('description')} rows={4} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="status">Status</Label>
              <Select id="status" {...form.register('status')}>
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Variants</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {variants.length === 0 && (
              <p className="text-sm text-muted-foreground">No variants yet.</p>
            )}
            {variants.map((v, index) => (
              <div
                key={v._stableKey ?? v.id ?? index}
                className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end p-3 rounded-md border border-border"
              >
                <div className="space-y-1">
                  <Label className="text-xs">SKU</Label>
                  <Input
                    value={v.sku}
                    onChange={(e) => updateVariant(index, { sku: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Title</Label>
                  <Input
                    value={v.title}
                    onChange={(e) => updateVariant(index, { title: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Price (cents)</Label>
                  <Input
                    type="number"
                    value={v.priceAmount}
                    onChange={(e) => updateVariant(index, { priceAmount: Number(e.target.value) })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Currency</Label>
                  <Input
                    value={v.currency}
                    onChange={(e) =>
                      updateVariant(index, { currency: e.target.value.toUpperCase() })
                    }
                    maxLength={3}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Stock</Label>
                  <Input
                    type="number"
                    value={v.stockQuantity}
                    onChange={(e) =>
                      updateVariant(index, { stockQuantity: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setVariantToDelete(index)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
            <Button type="button" variant="outline" onClick={addVariant}>
              <Plus className="h-4 w-4 mr-2" /> Add variant
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Images</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                disabled={uploading}
              />
              {uploading && <span className="text-sm text-muted-foreground">Uploading…</span>}
            </div>
            <div className="flex flex-wrap gap-3">
              {images.map((img) => (
                <div
                  key={img.id}
                  className="relative h-24 w-24 rounded-md border border-border overflow-hidden"
                >
                  <img src={img.url} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={async () => {
                      // S6: for persisted images (edit mode), call the detach endpoint first
                      if (isEdit && id) {
                        try {
                          await apiFetch(`/admin/v1/products/${id}/images/${img.imageId}`, {
                            method: 'DELETE',
                          });
                        } catch {
                          setError('Failed to remove image');
                          return;
                        }
                      }
                      setImages((prev) => prev.filter((i) => i.id !== img.id));
                    }}
                    className="absolute top-1 right-1 p-1 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    aria-label="Remove image"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Categories & Tags</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Categories</Label>
              <div className="flex flex-wrap gap-2">
                {categories?.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() =>
                      setAssignedCategoryIds((prev) =>
                        prev.includes(cat.id)
                          ? prev.filter((id) => id !== cat.id)
                          : [...prev, cat.id],
                      )
                    }
                    className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                      assignedCategoryIds.includes(cat.id)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-transparent text-foreground border-input hover:bg-muted'
                    }`}
                  >
                    {cat.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-2">
                {tags?.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() =>
                      setAssignedTagIds((prev) =>
                        prev.includes(tag.id)
                          ? prev.filter((id) => id !== tag.id)
                          : [...prev, tag.id],
                      )
                    }
                    className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                      assignedTagIds.includes(tag.id)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-transparent text-foreground border-input hover:bg-muted'
                    }`}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">SEO</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="seoTitle">SEO Title</Label>
              <Input id="seoTitle" {...form.register('seoTitle')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="seoDescription">SEO Description</Label>
              <Textarea id="seoDescription" {...form.register('seoDescription')} rows={3} />
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" isLoading={saveMutation.isPending}>
            {isEdit ? 'Save changes' : 'Create product'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => navigate('/products')}>
            {t('common', 'cancel')}
          </Button>
        </div>
      </form>

      <Dialog
        open={variantToDelete !== null}
        onClose={() => setVariantToDelete(null)}
        title="Delete variant"
        description="Are you sure you want to remove this variant?"
      >
        <div className="flex items-center justify-end gap-3 mt-4">
          <Button variant="secondary" onClick={() => setVariantToDelete(null)}>
            {t('common', 'cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => variantToDelete !== null && removeVariant(variantToDelete)}
          >
            {t('common', 'delete')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
