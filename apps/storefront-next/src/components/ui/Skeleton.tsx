/**
 * Skeleton primitive: a token-coloured placeholder block matching the eventual layout with no layout shift.
 * RSC / presentational. The pulse animation is `motion-safe:` only, so it is disabled under
 * `prefers-reduced-motion` — the block still shows (a steady placeholder), it just doesn't pulse.
 *
 * Uses `--muted` so it reads correctly in BOTH light and dark mode. Decorative by default
 * (`aria-hidden`) — the page-level `loading.tsx` wrappers carry the single `role="status"` /
 * `aria-busy` + localized busy label so screen readers announce "loading" ONCE, not per block.
 */
import type { HTMLAttributes } from 'react';

export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={['rounded-md bg-muted motion-safe:animate-pulse', className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
}

/** A product-card skeleton matching `ProductCard`'s footprint (image square + two text lines). */
export function ProductCardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <Skeleton className="aspect-square w-full" />
      <Skeleton className="mt-3 h-4 w-3/4" />
      <Skeleton className="mt-2 h-4 w-1/3" />
    </div>
  );
}

/** A responsive grid of product-card skeletons (matches `ProductGrid`'s columns). */
export function ProductGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <ProductCardSkeleton key={i} />
      ))}
    </div>
  );
}
