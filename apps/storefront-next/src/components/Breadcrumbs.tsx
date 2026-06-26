/**
 * Breadcrumbs — a semantic breadcrumb trail for the PDP + category detail pages.
 * RSC / presentational: uses `useTranslations` from `next-intl` (server-safe, same idiom as
 * `Header`/`Footer`) for the localized `<nav aria-label>` and the "Home" root crumb; the trail items
 * themselves are catalog DATA (category/product names) which stay single-language.
 *
 * Markup (WCAG accessible): `<nav aria-label>` wrapping an ordered list `<ol>`. Every crumb except
 * the last is a locale-aware `<Link>`; the LAST crumb is the current page — rendered as plain text
 * with `aria-current="page"` and NO link. Separators are decorative (`aria-hidden`) so they aren't
 * announced. Logical spacing only (no hard-coded left/right) for RTL-readiness.
 *
 * The `items` prop is the trail AFTER the Home root (which this component prepends + localizes), each
 * `{ label, href }`. This `{ label, href }[]` shape is deliberately the same data a `BreadcrumbList`
 * JSON-LD needs (name + item URL), so JSON-LD structured data can be emitted from the same array without
 * reshaping — this component does not add JSON-LD itself.
 */
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

/** A single breadcrumb: a display `label` and the locale-LESS `href` (next-intl `Link` adds locale). */
export interface BreadcrumbItem {
  label: string;
  href: string;
}

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  const t = useTranslations('breadcrumbs');
  // Prepend the localized Home root; the full trail is Home → …items, last = current page.
  const trail: BreadcrumbItem[] = [{ label: t('home'), href: '/' }, ...items];

  return (
    <nav aria-label={t('ariaLabel')} className="mb-6 text-sm text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-2">
        {trail.map((crumb, idx) => {
          const isLast = idx === trail.length - 1;
          return (
            <li key={`${crumb.href}-${idx}`} className="flex items-center gap-2">
              {isLast ? (
                <span aria-current="page" className="font-medium text-foreground">
                  {crumb.label}
                </span>
              ) : (
                <Link href={crumb.href} className="hover:text-foreground transition-colors">
                  {crumb.label}
                </Link>
              )}
              {!isLast && (
                <span aria-hidden="true" className="text-muted-foreground/60">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
