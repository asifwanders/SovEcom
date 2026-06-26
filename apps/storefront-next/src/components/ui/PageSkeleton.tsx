/**
 * Page-level skeleton wrappers. Each catalog route's
 * `loading.tsx` renders one of these while its RSC data is fetched. The wrapper carries the SINGLE
 * `role="status"` + `aria-busy="true"` + a localized `aria-label` (from the `loading` namespace), so
 * a screen reader announces "loading" once for the whole page; the inner `Skeleton` blocks are
 * decorative (`aria-hidden`). Layout mirrors the eventual page (no layout shift on load).
 *
 * RSC: `useTranslations` resolves against the active request locale (next-intl), so these are
 * localized without taking `params`.
 */
import { useTranslations } from 'next-intl';
import { Skeleton, ProductGridSkeleton } from './Skeleton';

function Busy({ children }: { children: React.ReactNode }) {
  const t = useTranslations('loading');
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t('label')}
      className="mx-auto max-w-6xl px-4 py-8"
    >
      {children}
    </div>
  );
}

/** Home: hero band + a heading + a featured product grid. */
export function HomeSkeleton() {
  return (
    <Busy>
      <Skeleton className="h-40 w-full md:h-56" />
      <Skeleton className="mt-10 h-7 w-48" />
      <div className="mt-6">
        <ProductGridSkeleton />
      </div>
    </Busy>
  );
}

/** A listing page (products / category PLP / search results): a heading + a product grid. */
export function ListingSkeleton() {
  return (
    <Busy>
      <Skeleton className="h-7 w-48" />
      <div className="mt-6">
        <ProductGridSkeleton />
      </div>
    </Busy>
  );
}

/** Category index: a heading + a grid of category cards. */
export function CategoryIndexSkeleton() {
  return (
    <Busy>
      <Skeleton className="h-7 w-40" />
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    </Busy>
  );
}

/** Product detail: breadcrumb + image + title/price/variants column. */
export function ProductDetailSkeleton() {
  return (
    <Busy>
      <Skeleton className="h-4 w-48" />
      <div className="mt-6 grid grid-cols-1 gap-8 md:grid-cols-2">
        <Skeleton className="aspect-square w-full" />
        <div>
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="mt-4 h-6 w-1/4" />
          <Skeleton className="mt-8 h-5 w-1/3" />
          <Skeleton className="mt-3 h-20 w-full" />
        </div>
      </div>
    </Busy>
  );
}
