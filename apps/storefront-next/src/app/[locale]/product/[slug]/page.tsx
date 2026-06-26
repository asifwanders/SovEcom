/**
 * Product Detail Page. RSC, ISR 5min. Reads a single
 * published product via the data-layer (`fetchProductBySlug`, client-js only);
 * an unknown slug (API 404) or a cold/unreachable API resolves to `null` → `notFound()`.
 *
 * SCOPE: the page is an RSC catalog read with a CLIENT ISLAND — `<VariantSelector>` lets the shopper choose a variant and add it to the cart.
 * The page itself stays a server component and KEEPS emitting the
 * Product/Offer + BreadcrumbList JSON-LD below (the island renders no structured data), so SEO is
 * unchanged. Prices inside the island render via the currency-correct `formatPrice` (server minor units,
 * never client math). Description / images / variants may all be absent and the page renders gracefully.
 *
 * Chrome is localized via the `product` namespace; product DATA (title/description/variant
 * options) stays single-language (`fetchProductBySlug` is NOT locale-aware). Inline
 * spacing uses logical `ms-*` (margin-inline-start) for RTL-readiness.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { fetchProductBySlug, type ProductDetailView } from '@/lib/catalog';
import { fetchActiveTheme } from '@/lib/theme';
import { resolveActiveThemeName } from '@/themes/active-theme';
import { renderSections } from '@/lib/sections/renderSections';
import { Slot } from '@/components/Slot';
import { type BreadcrumbItem } from '@/components/Breadcrumbs';
import { StructuredData } from '@/components/StructuredData';
import {
  siteOrigin,
  absoluteUrl,
  localizedPath,
  buildProductJsonLd,
  buildBreadcrumbJsonLd,
} from '@/lib/seo';
import { buildRouteMetadata } from '@/lib/metadata';
import type { Locale } from '@/i18n/routing';

// Time-based ISR — product pages revalidate every 5 minutes.
export const revalidate = 300;

/**
 * PDP metadata: localized title/description from the product DATA (single-language),
 * canonical + hreflang alternates, and the product image as the OG/Twitter card image.
 * An unknown slug (null) returns `{}` so Next falls back to the layout defaults.
 * The fetch is `cache`-wrapped; client-js bypasses Next's native fetch dedup, so `cache()` dedups.
 * This and the page body share one round-trip per render pass.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const product = await fetchProductBySlug(slug);
  if (!product) return {};
  const origin = siteOrigin();
  const image = product.images.find((img) => img.thumbnailUrl)?.thumbnailUrl;
  return buildRouteMetadata({
    origin,
    locale,
    path: `/product/${product.slug}`,
    title: product.title,
    ...(product.description ? { description: product.description } : {}),
    ...(image ? { images: [image] } : {}),
  });
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ locale: Locale; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('product');
  // PAGE-LEVEL guard (parity/SEO): fetch the product to 404 unknown slugs + build the JSON-LD. The
  // fetch is `cache`-wrapped, so this guard, `generateMetadata`, and the section loaders
  // (breadcrumbs + product-main) share ONE round-trip per render pass.
  const product: ProductDetailView | null = await fetchProductBySlug(slug);
  if (!product) notFound();

  // The crumb trail AFTER Home — the breadcrumbs SECTION renders the visible trail (prepending Home);
  // this same `{ label, href }[]` shape feeds the page-level BreadcrumbList JSON-LD (full trail incl.
  // Home, so positions/URLs match). JSON-LD stays page-level (SEO parity — sections emit none).
  const crumbsAfterHome: BreadcrumbItem[] = [
    { label: t('productsRoot'), href: '/products' },
    { label: product.title, href: `/product/${product.slug}` },
  ];
  const origin = siteOrigin();
  const tBc = await getTranslations('breadcrumbs');
  const fullTrail: BreadcrumbItem[] = [{ label: tBc('home'), href: '/' }, ...crumbsAfterHome];
  const productUrl = absoluteUrl(origin, localizedPath(locale, `/product/${product.slug}`));
  const productLd = buildProductJsonLd(product, productUrl);
  const breadcrumbLd = buildBreadcrumbJsonLd(origin, locale, fullTrail);

  // Compose the PDP body from the active theme's `product` template: the
  // breadcrumbs + product-main composite sections. `themeName` comes from the `cache()`-wrapped
  // `fetchActiveTheme` (shared with the layout); `params.slug` is threaded to the section loaders.
  const theme = await fetchActiveTheme();
  const sections = await renderSections({
    page: 'product',
    themeName: resolveActiveThemeName(theme),
    wireTemplates: theme?.templates,
    locale,
    params: { slug },
  });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* PDP structured data: Product/Offer + BreadcrumbList — kept PAGE-LEVEL. */}
      <StructuredData data={productLd} />
      <StructuredData data={breadcrumbLd} />
      {sections}
      {/* Module slots: the canonical PDP slots, route-scoped to this product. Each is
          its own async RSC and renders nothing unless a module binds it cleanly — a failing/empty module
          is invisible and the PDP above renders unchanged. `route` carries the PRODUCT ID: the
          module's gated catalog read is id-keyed, so the id is the correct key. */}
      <Slot name="product-detail-reviews-section" route={product.id} />
      <Slot name="product-detail-actions" route={product.id} />
    </div>
  );
}
