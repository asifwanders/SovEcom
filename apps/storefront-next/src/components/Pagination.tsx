/**
 * Minimal offset-pagination nav for the search-backed listing surfaces.
 *
 * The `/store/v1/search` endpoint is page-based (page + pageSize + total), unlike the cursor-based
 * `/products` route — so category + search PLPs page via `?page=`. This renders Previous / Next
 * links that preserve the surface's existing query params (slug is in `basePath`; sort / q are
 * passed in `params`). Deliberately inline/minimal markup — NOT the 3.7 component library.
 *
 * `Previous` is hidden on page 1; `Next` is hidden once `page * pageSize >= total` (last page).
 * The page count derives from `total`, so the nav stays consistent with the displayed total.
 */
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { buttonClasses } from '@/components/ui/Button';

export function Pagination({
  basePath,
  page,
  pageSize,
  total,
  params = {},
}: {
  basePath: string;
  page: number;
  pageSize: number;
  total: number;
  params?: Record<string, string>;
}) {
  const t = useTranslations('pagination');
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  if (!hasPrev && !hasNext) return null;

  const hrefFor = (target: number) => {
    const sp = new URLSearchParams(params);
    sp.set('page', String(target));
    return `${basePath}?${sp.toString()}`;
  };

  // Secondary (bordered) button styling at the lg size — reuses the ui/Button token classes.
  const linkClass = buttonClasses('secondary', 'lg');

  return (
    <nav className="mt-8 flex items-center justify-between gap-4" aria-label={t('ariaLabel')}>
      {hasPrev ? (
        <Link href={hrefFor(page - 1)} rel="prev" className={linkClass}>
          {t('previous')}
        </Link>
      ) : (
        <span />
      )}
      <span className="text-sm text-muted-foreground">
        {t('pageOf', { page, total: totalPages })}
      </span>
      {hasNext ? (
        <Link href={hrefFor(page + 1)} rel="next" className={linkClass}>
          {t('next')}
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
