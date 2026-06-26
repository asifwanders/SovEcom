/**
 * `/products` PLP sections — the all-products listing decomposed onto the
 * section runtime, parity-neutral. FLAT template (no `columns`): a header, the product grid (or empty
 * state), and a cursor "Load more" link. The grid + load-more loaders share ONE cached `fetchProducts`
 * via the `cache()`-stable `productListArgs` builder → a single round-trip per render pass.
 *
 * Parity: the heading + empty-state text + grid markup + the locale-aware "Load more" `<Link>` (and
 * its `?cursor=` href) are byte-for-byte the pre-refactor `products/page.tsx`.
 */
import { getTranslations } from 'next-intl/server';
import { fetchProducts, type ProductListView } from '@/lib/catalog';
import { ProductGrid } from '@/components/ProductGrid';
import { productCardActions } from '@/components/cardActions';
import { buttonClasses } from '@/components/ui/Button';
import { Link } from '@/i18n/navigation';
import type { Section, SectionContext, SectionSettings } from '@/lib/sections/registry';
import { productListArgs } from '@/lib/sections/search-args';

// ── products-header (h1) ───────────────────────────────────────────────────────────────────────

async function ProductsHeader({
  settings: _s,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const t = await getTranslations('products');
  return <h1 className="text-2xl font-semibold mb-6">{t('title')}</h1>;
}

export const ProductsHeaderSection: Section = {
  type: 'products-header',
  Component: ProductsHeader,
};

// ── product-grid (the products, or the empty state) ────────────────────────────────────────────

interface ProductsGridData {
  list: ProductListView;
}

async function loadProductsGrid(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<ProductsGridData> {
  return { list: await fetchProducts(productListArgs(ctx.searchParams)) };
}

async function ProductsGrid({
  data,
  locale,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const t = await getTranslations('products');
  const d = data as ProductsGridData | undefined;
  const products = d?.list.products ?? [];
  if (products.length === 0) {
    return <p className="text-muted-foreground">{t('empty')}</p>;
  }
  return <ProductGrid products={products} locale={locale} cardActions={productCardActions} />;
}

export const ProductsGridSection: Section = {
  type: 'product-grid',
  loader: loadProductsGrid,
  Component: ProductsGrid,
};

// ── products-load-more (cursor Link, or nothing) ───────────────────────────────────────────────

interface ProductsLoadMoreData {
  nextCursor: string | null;
  hasProducts: boolean;
}

async function loadProductsLoadMore(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<ProductsLoadMoreData> {
  const list = await fetchProducts(productListArgs(ctx.searchParams));
  return { nextCursor: list.nextCursor, hasProducts: list.products.length > 0 };
}

async function ProductsLoadMore({
  data,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const t = await getTranslations('products');
  const d = data as ProductsLoadMoreData | undefined;
  // The pre-refactor page only renders "Load more" inside the non-empty results branch AND only when a
  // nextCursor exists — mirror both gates so the empty-state DOM is identical.
  if (!d || !d.hasProducts || !d.nextCursor) return null;
  return (
    <div className="mt-8 flex justify-center">
      <Link
        href={`/products?cursor=${encodeURIComponent(d.nextCursor)}`}
        className={buttonClasses('secondary', 'lg')}
      >
        {t('loadMore')}
      </Link>
    </div>
  );
}

export const ProductsLoadMoreSection: Section = {
  type: 'products-load-more',
  loader: loadProductsLoadMore,
  Component: ProductsLoadMore,
};
