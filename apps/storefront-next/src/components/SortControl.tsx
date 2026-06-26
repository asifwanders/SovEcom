/**
 * Sort control. A no-JS RSC `<form method="get">`: it submits the
 * chosen `sort` as a URL query param via a native GET form, so sorting works WITHOUT JavaScript
 * (resilient progressive enhancement — no client bundle, no Server Action, no React Compiler). The
 * server route reads `?sort=` and re-renders. Extracted from the inline form the category page
 * hand-rolled so the category + search PLPs share one control.
 *
 * Because a native GET form would DROP any query param not represented as a field, the current
 * filter state (`q`/`category`/`minPrice`/`maxPrice`) is re-emitted as hidden inputs so a sort
 * submit PRESERVES the active filters. `page` is deliberately NOT preserved — changing the sort
 * resets pagination to page 1 (omitting `page` defaults the route to 1).
 *
 * `action` is the locale-prefixed route path the caller passes (e.g. `/en/category/apparel` or
 * `/en/search`) — a plain `<form action>` is locale-LESS-agnostic, so the caller prefixes it (same
 * pattern as the search/category native forms). a11y: a labelled native `<select>`
 * (keyboard- + SR-accessible for free) + a visible Apply submit; ≥44px Apply target.
 */
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import type { Locale } from '@/i18n/routing';

export type SortValue = 'relevance' | 'price_asc' | 'price_desc' | 'newest';

export function SortControl({
  locale: _locale,
  action,
  sort,
  preserve = {},
}: {
  /** Active route locale (documented intent; the prefixed `action` already carries it). */
  locale: Locale;
  /** Locale-prefixed route path the GET form submits to (e.g. `/en/category/apparel`). */
  action: string;
  /** The currently-applied sort value (drives the selected option). */
  sort: SortValue;
  /** Other URL params to carry through a sort submit (q/category/minPrice/maxPrice). Blank → omitted. */
  preserve?: Record<string, string | undefined>;
}) {
  const t = useTranslations('category');

  // Re-emit the active filter params as hidden inputs so a native GET submit keeps them. `page` is
  // intentionally excluded — changing the sort resets pagination to 1.
  const hidden = Object.entries(preserve).filter(
    ([key, value]) => key !== 'page' && key !== 'sort' && value !== undefined && value !== '',
  );

  return (
    <form action={action} method="get" className="flex items-center gap-2">
      {hidden.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      <label htmlFor="sort" className="text-sm text-muted-foreground">
        {t('sortLabel')}
      </label>
      <Select id="sort" name="sort" defaultValue={sort}>
        <option value="relevance">{t('sortRelevance')}</option>
        <option value="newest">{t('sortNewest')}</option>
        <option value="price_asc">{t('sortPriceAsc')}</option>
        <option value="price_desc">{t('sortPriceDesc')}</option>
      </Select>
      <Button type="submit" variant="secondary" size="sm">
        {t('apply')}
      </Button>
    </form>
  );
}
