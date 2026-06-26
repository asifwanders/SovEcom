/**
 * Granular PDP sections — the `product-main` composite decomposed into three independently-placeable
 * sections so a theme can rearrange them. Parity is maintained: the markup is VERBATIM from the
 * original `ProductMainSection` — the same gallery, the same info `space-y-6` (h1 + conditional
 * prose), and the same variant selector island. The PDP `columns` layout (in `product.json`) recreates
 * the exact `grid grid-cols-1 md:grid-cols-2 gap-8`, with the gallery in the `left` region and the
 * info + variant selector in the `right` region.
 *
 * Two of the three are CLIENT sections (the gallery + the variant selector are client islands): the
 * server renderer renders them as ELEMENTS (not awaited), but they keep a SERVER `loader` that fetches
 * the `cache()`-wrapped product via `ctx.params.slug` (shared with the page guard / `generateMetadata` /
 * the breadcrumbs + info loaders — one round-trip per render pass) and hands the island SERIALIZABLE
 * props. The middle `product-info` section is a plain RSC.
 */
import {
  fetchProductBySlug,
  type ProductDetailView,
  type ProductImageView,
  type ProductVariantView,
} from '@/lib/catalog';
import { ImageGallery, type GalleryLayout } from '@/components/ImageGallery';
import { VariantSelector } from '@/components/product/VariantSelector';
import type { Section, SectionContext, SectionSettings } from '@/lib/sections/registry';

/** Read the bounded `layout` gallery setting; an unknown/absent value → the default `carousel`. */
function galleryLayout(settings: SectionSettings): GalleryLayout {
  return settings.layout === 'grid' ? 'grid' : 'carousel';
}

/** Resolve the route slug from the render ctx (empty string when absent → no product → renders null). */
function slugOf(ctx: SectionContext): string {
  return ctx.params?.slug ?? '';
}

// ── product-gallery (CLIENT island) ──────────────────────────────────────────────────────────────

/** What the `product-gallery` loader resolves — the serializable gallery props for the client island. */
export interface ProductGalleryData {
  images: ProductImageView[];
  productTitle: string;
}

async function loadProductGallery(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<ProductGalleryData | null> {
  const product = await fetchProductBySlug(slugOf(ctx));
  if (!product) return null;
  // Verbatim from the composite: only images that actually have a thumbnail URL reach the gallery.
  return {
    images: product.images.filter((img) => img.thumbnailUrl),
    productTitle: product.title,
  };
}

function ProductGallery({
  settings,
  data,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const d = data as ProductGalleryData | null | undefined;
  if (!d) return null;
  // The `layout` setting (`carousel` default | `grid` all-images editorial) comes from the template.
  return (
    <ImageGallery
      images={d.images}
      productTitle={d.productTitle}
      layout={galleryLayout(settings)}
    />
  );
}

/** The registered `product-gallery` CLIENT section (loader fetches serializable props for the island). */
export const ProductGallerySection: Section = {
  type: 'product-gallery',
  client: true,
  loader: loadProductGallery,
  Component: ProductGallery,
};

// ── product-info (RSC) ─────────────────────────────────────────────────────────────────────────

/** What the `product-info` loader resolves — the cached product for the route slug. */
export interface ProductInfoData {
  product: ProductDetailView | null;
}

async function loadProductInfo(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<ProductInfoData> {
  return { product: await fetchProductBySlug(slugOf(ctx)) };
}

function ProductInfo({ data }: { settings: SectionSettings; data: unknown; locale: string }) {
  const product = (data as ProductInfoData | undefined)?.product;
  if (!product) return null;
  // Verbatim from the composite's info column: the h1 + conditional prose. PARITY: this renders a bare
  // FRAGMENT (no wrapper) so the `space-y-6` rhythm lives on the columns RIGHT-REGION wrapper, which
  // also contains the sibling `variant-selector` section — reproducing the pre-refactor single
  // `<div class="space-y-6">{h1}{prose}{VariantSelector}</div>` cell byte-for-byte (the selector keeps
  // its 1.5rem top gap below the description).
  return (
    <>
      <h1 className="text-3xl font-bold text-foreground">{product.title}</h1>

      {product.description && (
        <div className="prose prose-sm max-w-none text-foreground">
          <p>{product.description}</p>
        </div>
      )}
    </>
  );
}

/** The registered `product-info` RSC section (loader fetches the cached product). */
export const ProductInfoSection: Section = {
  type: 'product-info',
  loader: loadProductInfo,
  Component: ProductInfo,
};

// ── variant-selector (CLIENT island) ─────────────────────────────────────────────────────────────

/** What the `variant-selector` loader resolves — the serializable variant list for the island. */
export interface VariantSelectorData {
  variants: ProductVariantView[];
}

async function loadVariantSelector(
  _settings: SectionSettings,
  ctx: SectionContext,
): Promise<VariantSelectorData | null> {
  const product = await fetchProductBySlug(slugOf(ctx));
  if (!product) return null;
  return { variants: product.variants };
}

function VariantSelectorClient({
  data,
  locale,
}: {
  settings: SectionSettings;
  data: unknown;
  locale: string;
}) {
  const d = data as VariantSelectorData | null | undefined;
  if (!d) return null;
  // Verbatim from the composite: the interactive variant selector + add-to-cart client island. Renders
  // nothing when the product has no variants (nothing purchasable) — that branch lives in VariantSelector.
  return <VariantSelector variants={d.variants} locale={locale} />;
}

/** The registered `variant-selector` CLIENT section (loader fetches the serializable variant list). */
export const VariantSelectorSection: Section = {
  type: 'variant-selector',
  client: true,
  loader: loadVariantSelector,
  Component: VariantSelectorClient,
};
