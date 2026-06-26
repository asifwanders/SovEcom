/**
 * Breadcrumbs section — the PDP's breadcrumb trail extracted VERBATIM from the
 * pre-refactor `product/[slug]/page.tsx`. RSC. The loader fetches the `cache()`-wrapped product via
 * `ctx.params.slug` (shared with the page guard + metadata + the product-main loader — one round-trip
 * per render pass) and the component builds the AFTER-Home trail (`Products` → product) and renders
 * `<Breadcrumbs>` (which prepends + localizes the Home root). Parity is the gate: the DOM is identical
 * to the inline `<Breadcrumbs items={crumbsAfterHome} />`. The BreadcrumbList JSON-LD stays PAGE-LEVEL
 * (the page still builds it from the same `crumbsAfterHome` shape), so structured data is unchanged.
 */
import { getTranslations } from 'next-intl/server';
import { Breadcrumbs, type BreadcrumbItem } from '@/components/Breadcrumbs';
import { fetchProductBySlug } from '@/lib/catalog';
import type { Section, SectionContext, SectionSettings } from '@/lib/sections/registry';
import type { ProductInfoData } from './ProductSections';

async function loadProduct(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<ProductInfoData> {
  const slug = ctx.params?.slug ?? '';
  return { product: await fetchProductBySlug(slug) };
}

async function BreadcrumbsBlock({
  data,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const t = await getTranslations('product');
  const product = (data as ProductInfoData | undefined)?.product;
  if (!product) return null;

  // The crumb trail AFTER Home — the visible <Breadcrumbs> prepends + localizes the Home root. Same
  // `{ label, href }[]` shape the page uses to build the BreadcrumbList JSON-LD (kept page-level).
  const crumbsAfterHome: BreadcrumbItem[] = [
    { label: t('productsRoot'), href: '/products' },
    { label: product.title, href: `/product/${product.slug}` },
  ];

  return <Breadcrumbs items={crumbsAfterHome} />;
}

/** The registered `breadcrumbs` section (loader + component) for the server registry. */
export const BreadcrumbsSection: Section = {
  type: 'breadcrumbs',
  loader: loadProduct,
  Component: BreadcrumbsBlock,
};
