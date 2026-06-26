'use client';

/**
 * Faceted filter sidebar — CLIENT component using URL-state only (no Server Actions, no React Compiler,
 * no internal data fetching). Renders the `facets` the page already fetched via `fetchSearch` and on
 * change rewrites the current URL's query string via next-intl's `useRouter().replace` so the server
 * route re-runs the search with the new filters.
 *
 * State source of truth = the URL (`useSearchParams`); this component reads it, never mirrors it in
 * its own store beyond the price-input draft (a controlled text value the user is typing before they
 * apply). Every filter write:
 *   - PRESERVES `q` and `sort` (the search query + sort survive a filter change),
 *   - RESETS `page` to 1 (a filter change invalidates the current page offset),
 *   - writes prices in integer minor units (cents) via `majorToMinor` — never floats.
 *
 * Two modes:
 *   - search page → category facets are selectable (checkbox toggles `?category=`),
 *   - category page → `fixedCategory` is set (the route fixes the category), so the category group is
 *     hidden and only the price filter applies within that category.
 *
 * Accessibility: labelled `<form>` (aria-label "Filters"), each facet group a `<fieldset>` with
 * `<legend>`, category toggles are real `<input type=checkbox>` with bound labels, price inputs
 * are label-bound with ≥44px targets and visible focus rings. Mobile: a disclosure pattern collapses
 * the panel behind a labelled toggle with `aria-expanded`/`aria-controls`. Localized via `filters`.
 */
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { usePathname, useRouter } from '@/i18n/navigation';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { minorToMajor, majorToMinor } from '@/lib/api';
import type { SearchFacetsView } from '@/lib/catalog';

/** Params the sidebar owns; everything else (q/sort/…) is preserved untouched. `page` is always reset. */
const OWNED = ['category', 'minPrice', 'maxPrice', 'currency'] as const;

export function FilterSidebar({
  facets,
  currency,
  fixedCategory,
}: {
  /** The facets the RSC page fetched (`fetchSearch().facets`). */
  facets: SearchFacetsView;
  /** ISO-4217 currency the price filter is scoped to (the API constrains price math to one currency). */
  currency: string;
  /** When set, the category is fixed by the route (PLP) → the category facet group is hidden. */
  fixedCategory?: string;
}) {
  const t = useTranslations('filters');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const panelId = useId();
  const [open, setOpen] = useState(false);

  const activeCategory = params.get('category') ?? undefined;
  const activeMinMinor = params.get('minPrice');
  const activeMaxMinor = params.get('maxPrice');

  // Controlled price draft — pre-filled from the active URL params (minor → major for editing).
  const [minDraft, setMinDraft] = useState(
    activeMinMinor !== null ? String(minorToMajor(Number(activeMinMinor), currency)) : '',
  );
  const [maxDraft, setMaxDraft] = useState(
    activeMaxMinor !== null ? String(minorToMajor(Number(activeMaxMinor), currency)) : '',
  );

  /** Rewrite the URL: apply `next` on top of the preserved (q/sort) params; ALWAYS reset page. */
  function navigate(next: Partial<Record<(typeof OWNED)[number], string | null>>) {
    const sp = new URLSearchParams(params.toString());
    sp.delete('page'); // a filter change resets pagination to page 1
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === '') sp.delete(key);
      else sp.set(key, value);
    }
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  function toggleCategory(slug: string) {
    navigate({ category: activeCategory === slug ? null : slug });
  }

  function applyPrice(e: React.FormEvent) {
    e.preventDefault();
    const min = majorToMinor(minDraft, currency);
    const max = majorToMinor(maxDraft, currency);
    navigate({
      minPrice: min === null ? null : String(min),
      maxPrice: max === null ? null : String(max),
      // Scope the price filter to one currency (only meaningful when a bound is set).
      currency: min === null && max === null ? null : currency,
    });
  }

  function clearFilters() {
    setMinDraft('');
    setMaxDraft('');
    navigate({ category: null, minPrice: null, maxPrice: null, currency: null });
  }

  const showCategories = !fixedCategory && facets.categories.length > 0;
  const showPrice = facets.price !== null;
  const hasActiveFilters =
    (!fixedCategory && !!activeCategory) || activeMinMinor !== null || activeMaxMinor !== null;

  return (
    <aside className="sm:w-64 sm:shrink-0">
      {/* Mobile disclosure toggle (below sm); the panel is always shown at sm+. */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={buttonClasses('secondary', 'md', 'w-full justify-between sm:hidden')}
      >
        {t('heading')}
      </button>

      <form
        id={panelId}
        aria-label={t('heading')}
        onSubmit={applyPrice}
        className={`${open ? 'block' : 'hidden'} mt-3 space-y-6 sm:mt-0 sm:block`}
      >
        {showCategories && (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold text-foreground">
              {t('categoryLegend')}
            </legend>
            <ul className="space-y-1">
              {facets.categories.map((cat) => {
                const checked = activeCategory === cat.slug;
                return (
                  <li key={cat.slug}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-sm hover:bg-muted">
                      <input
                        type="checkbox"
                        name="category"
                        value={cat.slug}
                        checked={checked}
                        onChange={() => toggleCategory(cat.slug)}
                        className="h-4 w-4 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                      <span className="flex-1 text-foreground">{cat.name}</span>
                      <span className="text-xs text-muted-foreground" aria-hidden="true">
                        {cat.count}
                      </span>
                      <span className="sr-only">{t('facetCount', { count: cat.count })}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}

        {showPrice && (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-semibold text-foreground">
              {t('priceLegend')}
            </legend>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <label htmlFor="filter-min" className="mb-1 block text-xs text-muted-foreground">
                  {t('min')}
                </label>
                <Input
                  id="filter-min"
                  name="minPrice"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={minDraft}
                  onChange={(e) => setMinDraft(e.target.value)}
                  placeholder={t('min')}
                />
              </div>
              <div className="flex-1">
                <label htmlFor="filter-max" className="mb-1 block text-xs text-muted-foreground">
                  {t('max')}
                </label>
                <Input
                  id="filter-max"
                  name="maxPrice"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={maxDraft}
                  onChange={(e) => setMaxDraft(e.target.value)}
                  placeholder={t('max')}
                />
              </div>
            </div>
            <Button type="submit" variant="secondary" size="sm" className="w-full">
              {t('apply')}
            </Button>
          </fieldset>
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearFilters}
          disabled={!hasActiveFilters}
          className="w-full"
        >
          {t('clear')}
        </Button>
      </form>
    </aside>
  );
}
