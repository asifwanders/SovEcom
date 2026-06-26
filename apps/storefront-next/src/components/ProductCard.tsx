/**
 * ProductCard — the reusable product card extracted verbatim from the inline card
 * that lived in `ProductGrid.tsx`. RSC / presentational: no "use client", renders a
 * locale-aware `Link` to the PDP, the tenant-supplied thumbnail (plain `<img>`, `images.unoptimized`),
 * the title, and the `formatPrice`-rendered headline price. Visual output is UNCHANGED from the prior
 * inline markup — same token classes, same structure — this is an extraction, not a redesign.
 *
 * Image strategy: plain `<img>` with explicit intrinsic `width`/`height` (CLS
 * control with zero CDN) + `loading="lazy"`; the `h-full w-full object-cover` class keeps the rendered
 * size identical to before (the intrinsic attrs are a layout hint only).
 *
 * Slot seam: the `product-card-actions` module widget is rendered by the async `<Slot>` RSC, which
 * can't run inside this SYNC presentational card. So the card accepts a pre-rendered `actions` node
 * (the async parent renders `<Slot name="product-card-actions" route=… />` and passes it). Absent
 * (the default), the seam renders nothing — identical to the prior output. The seam sits OUTSIDE the
 * card `<Link>` (a module's actions are interactive — they must not nest inside an anchor); the wrapper
 * is a layout-neutral `display:contents` group.
 */
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { formatPrice } from '@/lib/api';
import type { ProductCardView } from '@/lib/catalog';

export function ProductCard({
  product,
  locale,
  actions,
}: {
  product: ProductCardView;
  /** Active locale — used for currency formatting. */
  locale?: string;
  /**
   * Pre-rendered `product-card-actions` module-slot node. The async parent renders the
   * `<Slot>` RSC and passes the result; absent means the seam renders nothing (prior output unchanged).
   */
  actions?: ReactNode;
}) {
  const tGallery = useTranslations('gallery');
  const hasPrice = product.priceAmount !== null && product.currency !== null;
  return (
    // `display:contents` wrapper: layout-neutral (the grid still lays out the card box directly), it
    // only exists to host the module seam as a SIBLING of the card link, never nested in the anchor.
    <div className="contents">
      <Link
        href={`/product/${product.slug}`}
        className="group rounded-lg border border-border bg-card overflow-hidden hover:shadow-md transition-shadow"
      >
        <div className="aspect-square bg-muted relative">
          {product.thumbnailUrl ? (
            // Plain <img>: thumbnails are tenant-supplied absolute URLs, next/image is `unoptimized`.
            // Explicit width/height are intrinsic CLS hints; object-cover keeps the fit.
            <img
              src={product.thumbnailUrl}
              alt={product.title}
              width={400}
              height={400}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center text-muted-foreground">
              {tGallery('noImage')}
            </div>
          )}
        </div>
        <div className="p-4">
          <h3 className="font-medium text-foreground group-hover:text-primary transition-colors line-clamp-1">
            {product.title}
          </h3>
          {hasPrice && (
            <p className="mt-1 text-sm font-medium text-primary">
              {formatPrice(product.priceAmount as number, product.currency as string, locale)}
            </p>
          )}
        </div>
      </Link>
      {/* Module seam `product-card-actions`. Sibling of the link, never inside the
          anchor. Pre-rendered by the async parent's `<Slot>`; absent means nothing renders. */}
      {actions ?? null}
    </div>
  );
}
