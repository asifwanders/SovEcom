/**
 * Featured-products section — extracted VERBATIM from the pre-refactor Home
 * "Featured products" block. RSC, no "use client". The product list is fetched by the section's
 * LOADER (see registry) and arrives here as `data.products`; this component is pure presentation so
 * the runtime can run all loaders in parallel. Markup/classes are identical to the inline block.
 */
import { getTranslations } from 'next-intl/server';
import { ProductGrid } from '@/components/ProductGrid';
import { productCardActions } from '@/components/cardActions';
import type { ProductCardView } from '@/lib/catalog';

/** What the `featured-products` loader resolves — the product page the grid renders. */
export interface FeaturedProductsData {
  products: ProductCardView[];
}

export async function FeaturedProductsSection({
  data,
  locale,
}: {
  settings: Record<string, unknown>;
  /** Loader output (`FeaturedProductsData`); typed `unknown` to match the registry `Section` contract. */
  data: unknown;
  locale: string;
}) {
  const t = await getTranslations('home');
  const products = (data as FeaturedProductsData | undefined)?.products ?? [];
  return (
    <section>
      <h2 className="text-2xl font-semibold mb-6">{t('featuredProducts')}</h2>
      {products.length === 0 ? (
        <p className="text-muted-foreground">{t('noProducts')}</p>
      ) : (
        <ProductGrid products={products} locale={locale} cardActions={productCardActions} />
      )}
    </section>
  );
}
