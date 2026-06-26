import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Dialog } from '@/components/ui/dialog';
import { Breadcrumbs } from '@/components/layout/breadcrumbs';
import { Package, Search, ChevronLeft, ChevronRight, Pencil, Trash2 } from 'lucide-react';

interface ProductVariant {
  id: string;
  sku: string;
  title: string | null;
  priceAmount: number;
  currency: string;
  stockQuantity: number;
  position: number;
}

interface ProductImage {
  id: string;
  imageId: string;
  position: number;
  imageRow: { url: string; altText: string | null } | null;
}

interface Product {
  id: string;
  title: string;
  slug: string;
  status: 'draft' | 'published' | 'archived';
  createdAt: string;
  variants: ProductVariant[];
  images: ProductImage[];
}

interface ProductListResponse {
  data: Product[];
  total: number;
  page: number;
  pageSize: number;
}

const statusVariant: Record<string, BadgeProps['variant']> = {
  draft: 'secondary',
  published: 'success',
  archived: 'warning',
};

export default function ProductsPage() {
  const navigate = useNavigate();
  const [page, setPage] = React.useState(1);
  const [statusFilter, setStatusFilter] = React.useState<string>('');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery<ProductListResponse>({
    queryKey: ['products', page, statusFilter, searchQuery],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (statusFilter) params.set('status', statusFilter);
      if (searchQuery) params.set('q', searchQuery);
      return apiFetch(`/admin/v1/products?${params.toString()}`);
    },
  });

  async function handleDelete() {
    if (!deleteId) return;
    try {
      await apiFetch(`/admin/v1/products/${deleteId}`, { method: 'DELETE' });
      setDeleteId(null);
      setDeleteError(null);
      refetch();
    } catch (e: unknown) {
      setDeleteId(null);
      setDeleteError(e instanceof Error ? e.message : t('common', 'genericError'));
    }
  }

  const totalPages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <div className="p-6 space-y-6">
      <Breadcrumbs
        items={[
          { label: t('layout', 'dashboard'), to: '/dashboard' },
          { label: t('layout', 'products') },
        ]}
      />

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Package className="h-6 w-6" aria-hidden="true" />
          {t('layout', 'products')}
        </h1>
        <Button onClick={() => navigate('/products/new')}>{t('common', 'create')}</Button>
      </div>

      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            placeholder="Search products..."
            className="pl-9"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </Select>
      </div>

      {(error || deleteError) && (
        <Alert variant="destructive">{deleteError ?? t('common', 'genericError')}</Alert>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Title</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Price</th>
              <th className="px-4 py-3 text-left font-medium">Stock</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  {t('common', 'loading')}
                </td>
              </tr>
            ) : data?.data.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  No products found.
                </td>
              </tr>
            ) : (
              data?.data.map((product) => {
                const cheapest =
                  product.variants.length > 0
                    ? product.variants.reduce(
                        (min, v) => (v.priceAmount < min.priceAmount ? v : min),
                        product.variants[0]!,
                      )
                    : null;
                const totalStock = product.variants.reduce((sum, v) => sum + v.stockQuantity, 0);
                return (
                  <tr key={product.id} className="hover:bg-muted/50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {product.images[0]?.imageRow?.url ? (
                          <img
                            src={product.images[0].imageRow.url}
                            alt=""
                            className="h-10 w-10 rounded-md object-cover border border-border"
                          />
                        ) : (
                          <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center">
                            <Package className="h-4 w-4 text-muted-foreground" />
                          </div>
                        )}
                        <div>
                          <p className="font-medium">{product.title}</p>
                          <p className="text-xs text-muted-foreground">{product.slug}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={statusVariant[product.status] ?? 'default'}
                        className="capitalize"
                      >
                        {product.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {cheapest ? formatMoney(cheapest.priceAmount, cheapest.currency) : '—'}
                    </td>
                    <td className="px-4 py-3">{totalStock}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => navigate(`/products/${product.id}`)}
                          aria-label="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteId(product.id)}
                          aria-label="Delete"
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {((data?.page ?? 1) - 1) * (data?.pageSize ?? 20) + 1}–
            {Math.min((data?.page ?? 1) * (data?.pageSize ?? 20), data?.total ?? 0)} of{' '}
            {data?.total} products
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={!!deleteId}
        onClose={() => {
          setDeleteId(null);
          setDeleteError(null);
        }}
        title="Delete product"
        description="This action cannot be undone. The product and all its variants will be permanently removed."
      >
        <div className="flex items-center justify-end gap-3 mt-4">
          <Button
            variant="secondary"
            onClick={() => {
              setDeleteId(null);
              setDeleteError(null);
            }}
          >
            {t('common', 'cancel')}
          </Button>
          <Button variant="destructive" onClick={handleDelete}>
            {t('common', 'delete')}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
